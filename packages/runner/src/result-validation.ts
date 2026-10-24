import { z } from "zod";
import type { DispatchConfig, Graph, Job } from "../../protocol/src/index.js";
import { decideSchema, executeSchema, reviewSchema } from "../../protocol/src/index.js";
import { validateReviewResult } from "../../protocol/src/review-validation.js";
import { ModelGuardError, guardMessage, redactModelError } from "../../protocol/src/model-errors.js";
import { parseModelJson } from "./prompts.js";

/**
 * A model may answer with an error report such as
 * `{"error":"Fact f1 not found","details":"..."}` instead of the job payload,
 * especially after a tool returned an error. That is a model-level refusal, not
 * a schema typo, so it gets its own message and one targeted serialization retry.
 */
export class ModelReportedError extends Error {
  constructor(readonly report: string) {
    super(`模型返回了错误说明而不是任务结果：${report}`);
    this.name = "ModelReportedError";
  }
}

const resultFields: Record<Job["kind"], string[]> = {
  decide: [
    "delete_nodes",
    "steps",
    "updates",
    "reopens",
    "finding_merges",
    "finding_updates",
    "assets",
    "closes",
    "goals",
    "hint_notes",
    "lead_dispositions",
    "complete",
  ],
  execute: ["facts", "findings", "leads", "summary"],
  review: ["verdict", "reason"],
};

/** An error envelope is only recognized when it carries no job result at all. */
function errorReport(payload: Record<string, unknown>, kind: Job["kind"]): string | undefined {
  if (!("error" in payload) || resultFields[kind].some((field) => field in payload)) return undefined;
  const error = payload.error;
  const text =
    typeof error === "string" ? error : error && typeof error === "object" ? JSON.stringify(error) : String(error);
  const details = typeof payload.details === "string" ? payload.details : "";
  return `${text}${details ? `（${details}）` : ""}`.slice(0, 1500);
}

export async function validateFinalResult(
  job: Job,
  graph: Graph,
  getCurrentGraph: () => Promise<Graph>,
  text: string | undefined,
) {
  const guard = guardMessage(text);
  if (guard) throw new ModelGuardError(guard);
  const payload = parseModelJson(text || "");
  const reported = errorReport(payload, job.kind);
  if (reported) throw new ModelReportedError(reported);
  if (job.kind === "decide")
    decideSchema.parse({
      ...payload,
      worker: job.worker,
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      graph_id: job.graph_id,
    });
  if (job.kind === "execute") executeSchema.parse({ ...payload, worker: job.worker });
  if (job.kind === "review") {
    const parsed = reviewSchema.parse({ ...payload, worker: job.worker, finding_version: job.finding_version });
    const current = await getCurrentGraph(),
      finding = current.findings.find((f) => f.id === job.finding_id);
    if (!finding || finding.version !== job.finding_version) throw new Error("Finding changed during review");
    validateReviewResult(current, finding, parsed);
  }
  return payload;
}

/** Repairs are bounded by both attempts and the original Run deadline; callers enforce read-only tools. */
export async function repairFinalResult(options: {
  job: Job;
  config: DispatchConfig;
  deadline: number;
  key: string;
  validate: (text: string | undefined) => Promise<Record<string, unknown>>;
  text: () => string | undefined;
  stopReason: () => string | undefined;
  leaseError: () => Error | undefined;
  trace: (text: string | undefined, attempt: number) => void;
  diagnose: (type: "result_validation" | "result_repair", data: Record<string, unknown>) => void;
  repair: (detail: string) => Promise<void>;
}) {
  const repairs = options.config.result_repairs ?? 1;
  // A model that reported an error instead of a result never received feedback
  // about that specific answer, so one extra repair is allowed after the usual
  // budget. It is still bounded and is disabled when repairs are disabled.
  let reportedRepairs = 0;
  for (let attempt = 0; ; attempt++) {
    const text = options.text();
    options.trace(text, attempt);
    try {
      if (options.stopReason() === "length") throw new Error("Truncated final response");
      const result = await options.validate(text);
      options.diagnose("result_validation", { repair: attempt, valid: true });
      return result;
    } catch (error) {
      if (error instanceof ModelGuardError) {
        options.diagnose("result_validation", { repair: attempt, valid: false, guard: error.guard.slice(0, 300) });
        throw error;
      }
      const reported = error instanceof ModelReportedError;
      const detail = redactModelError(
        error instanceof z.ZodError
          ? error.issues
              .slice(0, 8)
              .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
              .join("; ")
          : error instanceof Error
            ? error.message
            : "Invalid result",
        [options.key],
      ).slice(0, 1500);
      options.diagnose("result_validation", { repair: attempt, valid: false, detail, reported });
      const canRepair = attempt < repairs || (reported && repairs > 0 && reportedRepairs < 1);
      if (!canRepair || Date.now() >= options.deadline || options.leaseError()) {
        if (reported) throw new Error(`Model provider failure: ${detail}`);
        throw new Error(
          `Model provider failure: final JSON does not match the job protocol (${options.job.kind}): ${detail}`,
        );
      }
      if (reported) reportedRepairs++;
      options.diagnose("result_repair", { attempt: attempt + 1, detail, reported });
      await options.repair(detail);
    }
  }
}
