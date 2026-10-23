import { z } from "zod";
import type { DispatchConfig, Graph, Job } from "../../protocol/src/index.js";
import { decideSchema, executeSchema, reviewSchema } from "../../protocol/src/index.js";
import { validateReviewResult } from "../../protocol/src/review-validation.js";
import { redactModelError } from "../../protocol/src/model-errors.js";
import { parseModelJson } from "./prompts.js";

export async function validateFinalResult(
  job: Job,
  graph: Graph,
  getCurrentGraph: () => Promise<Graph>,
  text: string | undefined,
) {
  const payload = parseModelJson(text || "");
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
  for (let attempt = 0; ; attempt++) {
    const text = options.text();
    options.trace(text, attempt);
    try {
      if (options.stopReason() === "length") throw new Error("Truncated final response");
      const result = await options.validate(text);
      options.diagnose("result_validation", { repair: attempt, valid: true });
      return result;
    } catch (error) {
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
      options.diagnose("result_validation", { repair: attempt, valid: false, detail });
      if (attempt >= (options.config.result_repairs ?? 1) || Date.now() >= options.deadline || options.leaseError())
        throw new Error(
          `Model provider failure: final JSON does not match the job protocol (${options.job.kind}): ${detail}`,
        );
      options.diagnose("result_repair", { attempt: attempt + 1, detail });
      await options.repair(detail);
    }
  }
}
