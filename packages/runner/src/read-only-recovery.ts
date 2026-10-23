import { readFile, realpath, open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { DispatchConfig, Run } from "../../protocol/src/index.js";
import { digest } from "../../core/src/execution.js";
import { ApiClient } from "./client.js";
import { loadSubmission, replaySubmission, savedJobSchema } from "./submissions.js";
import { runJob } from "./run.js";

/** Explicit single-attempt recovery. Never claims a new Job or clears a blocked_run_id. */
export async function recoverReadOnly(file: string, config: DispatchConfig, client: ApiClient) {
  const { hash, ...record } = z.object({ version: z.literal(1), job: savedJobSchema, session_path: z.string().min(1),
    workspace: z.string().min(1), hash: z.string() }).strict().parse(JSON.parse(await readFile(file, "utf8")));
  if (hash !== digest(record) || record.job.kind !== "execute" || !record.job.run_id) throw new Error("Invalid Execute recovery record");
  const workspace = await realpath(record.workspace);
  const session = await realpath(record.session_path);
  if (relative(join(workspace, "sessions"), session).startsWith("..")) throw new Error("Recovery session must be in the project's sessions directory");
  const directory = resolve(workspace, "runs", record.job.worker);
  if (await realpath(dirname(file)) !== await realpath(directory)) throw new Error("Recovery record must remain in its Run directory");
  // A saved final operation has priority: replay its original key/body, without starting a model.
  const pending = join(directory, "pending-result.json");
  const saved = await loadSubmission(pending).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (saved) {
    if (digest(saved.record.job) !== digest(record.job)) throw new Error("Saved result belongs to a different Run");
    return replaySubmission(pending, client);
  }
  const run = await client.request<Run>(client.projectPath(record.job, `/runs/${encodeURIComponent(record.job.run_id)}`));
  if (run.status !== "running" || run.worker !== record.job.worker || run.node_id !== record.job.step_id ||
    run.kind !== "execute" || !run.session_path || await realpath(run.session_path) !== session)
    throw new Error("Read-only recovery requires the original running Run and its recorded session");
  await client.request(client.projectPath(record.job, "/jobs/heartbeat"), record.job);
  // Durable one-shot marker survives process loss; no automatic repeated model recovery.
  const marker = await open(join(directory, "recovery-attempt.json"), "wx", 0o600);
  try { await marker.writeFile(JSON.stringify({ at: new Date().toISOString(), run_id: record.job.run_id })); await marker.sync(); }
  finally { await marker.close(); }
  const seconds = config.task_timeout_seconds === 0 ? 0 : config.closeout_seconds ?? Math.min(60, Math.floor(config.task_timeout_seconds / 3));
  return runJob(record.job, { ...config, task_timeout_seconds: seconds,
    closeout_seconds: seconds === 0 ? config.closeout_seconds : Math.max(1, seconds - 1) }, client, workspace, session);
}
