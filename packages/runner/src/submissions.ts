import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Job } from "../../protocol/src/index.js";
import { digest } from "../../core/src/execution.js";
import { ApiClient, ApiError, type CommitAttempt } from "./client.js";

export const savedJobSchema = z
  .object({
    kind: z.enum(["decide", "execute", "review", "peer"]),
    project_id: z.string().min(1),
    worker: z.string().min(1),
    graph_id: z.string().min(1),
    run_id: z.string().min(1),
    step_id: z.string().optional(),
    finding_id: z.string().optional(),
    finding_version: z.number().int().optional(),
    peer_id: z.string().optional(),
  })
  .strict();
const submissionSchema = z
  .object({
    version: z.literal(1),
    job: savedJobSchema,
    operation: z.string(),
    submission_id: z.string().uuid(),
    payload: z.record(z.string(), z.unknown()),
    payload_hash: z.string(),
    created_at: z.string().datetime(),
    state: z.enum(["pending", "accepted", "rejected"]),
    accepted_at: z.string().datetime().optional(),
    rejected_status: z.number().int().optional(),
  })
  .strict();
export type SavedSubmission = z.infer<typeof submissionSchema>;
const referenceSchema = z
  .object({
    format: z.literal("tessera-submission-reference-v1"),
    submission_file: z.string().regex(/^submissions\/[0-9a-f-]+\.json$/),
    submission_id: z.string().uuid(),
    run_id: z.string(),
    payload_hash: z.string(),
  })
  .strict();

export async function durableJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    // fsync the directory entry where supported; Windows does not support opening directories this way.
    if (process.platform !== "win32") {
      const directory = await open(dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function validate(record: SavedSubmission) {
  const { job, payload, operation } = record;
  const prefix = `/projects/${encodeURIComponent(job.project_id)}`;
  const peerPrefix = `${prefix}/fgs/peers/${job.peer_id}`;
  const allowed =
    job.kind === "decide"
      ? [`${prefix}/fgs/decisions`]
      : job.kind === "review"
        ? [`${prefix}/findings/${job.finding_id}/review`]
        : job.kind === "peer"
          ? [
              `${peerPrefix}/facts`,
              `${peerPrefix}/findings`,
              `${peerPrefix}/messages`,
              `${peerPrefix}/spawn`,
              `${peerPrefix}/retire`,
              `${peerPrefix}/turn-end`,
              `${peerPrefix}/completion/propose`,
              `${peerPrefix}/completion/respond`,
              `${peerPrefix}/assets`,
            ]
          : [
              `${prefix}/evidence`,
              `${prefix}/assets`,
              ...["facts", "findings", "execute"].map((action) => `${prefix}/fgs/steps/${job.step_id}/${action}`),
            ];
  // The runner also archives oversized read-tool output for Decide/Review; this is not a model write capability.
  allowed.push(`${prefix}/evidence`);
  allowed.push(`${prefix}/fgs/bookmarks`);
  // In-place Fact bookkeeping is a model write only for Decide and Execute.
  // Operation carries the Fact id, so it is matched by shape rather than listed.
  const revisionPath = `${prefix}/fgs/facts/`;
  const canReviseFacts = job.kind === "decide" || job.kind === "execute";
  if (
    (!allowed.includes(operation) &&
      !(canReviseFacts && operation.startsWith(revisionPath) && operation.endsWith("/revisions"))) ||
    "submission_id" in payload ||
    "run_id" in payload ||
    (payload.worker !== undefined && payload.worker !== job.worker)
  )
    throw new Error("Saved submission does not match its Job/operation");
  const hash = digest({ job, operation, submission_id: record.submission_id, payload });
  if (hash !== record.payload_hash) throw new Error("Saved submission content hash mismatch; refusing replay");
}

/** Latest-result references are navigation only; immutable operation/key/body live in individual records. */
export async function loadSubmission(file: string): Promise<{ file: string; record: SavedSubmission }> {
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.format === "tessera-submission-reference-v1") {
    const ref = referenceSchema.parse(data);
    const loaded = await loadSubmissionRecord(resolve(dirname(file), ref.submission_file));
    if (
      loaded.record.submission_id !== ref.submission_id ||
      loaded.record.job.run_id !== ref.run_id ||
      loaded.record.payload_hash !== ref.payload_hash
    )
      throw new Error("Submission reference does not match saved record");
    return loaded;
  }
  return loadSubmissionRecord(file, data);
}
async function loadSubmissionRecord(file: string, data?: unknown) {
  const record = submissionSchema.parse(data ?? JSON.parse(await readFile(file, "utf8")));
  validate(record);
  return { file, record };
}

export async function replaySubmission<T = unknown>(
  file: string,
  client: ApiClient,
  observe?: (event: CommitAttempt) => void,
): Promise<T> {
  const loaded = await loadSubmission(file);
  const record = loaded.record;
  if (record.state === "rejected")
    throw new Error("Saved submission was semantically rejected; refresh state instead of replaying");
  try {
    const result = await client.commit<T>(
      record.operation,
      record.payload,
      record.job.run_id,
      record.submission_id,
      observe,
    );
    await durableJson(loaded.file, { ...record, state: "accepted", accepted_at: new Date().toISOString() });
    return result;
  } catch (error) {
    if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status))
      await durableJson(loaded.file, { ...record, state: "rejected", rejected_status: error.status });
    throw error;
  }
}

export class SubmissionOutbox {
  constructor(
    readonly directory: string,
    readonly job: Job,
    readonly client: ApiClient,
    readonly observe?: (event: CommitAttempt) => void,
  ) {}
  async prepare(operation: string, payload: Record<string, unknown>, final = false) {
    const job = savedJobSchema.parse(this.job);
    // Freeze JSON wire semantics before hashing or sending; later caller mutation cannot alter a saved submission.
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const submission_id = randomUUID();
    const record: SavedSubmission = {
      version: 1,
      job,
      operation,
      submission_id,
      payload: body,
      payload_hash: digest({ job, operation, submission_id, payload: body }),
      state: "pending",
      created_at: new Date().toISOString(),
    };
    validate(record);
    const file = join(this.directory, "submissions", `${submission_id}.json`);
    await durableJson(file, record);
    if (final)
      await durableJson(join(this.directory, "pending-result.json"), {
        format: "tessera-submission-reference-v1",
        submission_file: `submissions/${submission_id}.json`,
        submission_id,
        run_id: job.run_id,
        payload_hash: record.payload_hash,
      });
    try {
      this.observe?.({
        stage: "prepared",
        operation,
        submission_id,
        run_id: job.run_id,
        attempt: 0,
        payload_hash: record.payload_hash,
        submission_file: file,
        final,
      });
    } catch {}
    return file;
  }
  async submit<T = unknown>(operation: string, payload: Record<string, unknown>, final = false): Promise<T> {
    const file = await this.prepare(operation, payload, final);
    return replaySubmission<T>(file, this.client, this.observe);
  }
}
