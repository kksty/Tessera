import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Job, Run } from "../../protocol/src/index.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** All mutations are called inside the Store transaction, separately from FGS data. */
export class ExecutionRecords {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,worker TEXT NOT NULL,kind TEXT NOT NULL,node_id TEXT,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_run_project ON platform_runs(project_id,status);
      CREATE INDEX IF NOT EXISTS platform_run_worker ON platform_runs(project_id,worker);
      CREATE TABLE IF NOT EXISTS platform_run_models(run_id TEXT PRIMARY KEY REFERENCES platform_runs(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_receipts(project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,operation TEXT NOT NULL,submission_id TEXT NOT NULL,payload_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(project_id,operation,submission_id));
      CREATE TABLE IF NOT EXISTS platform_request_usage(run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,request_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,request_id));
    `);
  }
  create(job: Job, claimId?: string): Job {
    const node = job.step_id || job.finding_id || job.peer_id || job.graph_id;
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM platform_runs WHERE project_id=? AND kind=? AND node_id=?")
      .get(job.project_id, job.kind, node);
    const time = new Date().toISOString();
    const run: Run = {
      id: `run_${randomUUID()}`,
      project_id: job.project_id,
      kind: job.kind,
      worker: job.worker,
      graph_id: job.graph_id,
      node_id: node,
      ...(claimId ? { claim_id: claimId } : {}),
      ...(job.finding_version === undefined ? {} : { finding_version: job.finding_version }),
      attempt: Number(count?.n || 0) + 1,
      status: "running",
      started_at: time,
      heartbeat_at: time,
      finished_at: null,
      external_action_possible: false,
      input: null,
      output: null,
      cost: null,
      request_count: 0,
    };
    this.save(run);
    return { ...job, run_id: run.id };
  }
  get(project: string, id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM platform_runs WHERE project_id=? AND id=?").get(project, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  worker(project: string, worker: string): Run | undefined {
    const row = this.db
      .prepare("SELECT data FROM platform_runs WHERE project_id=? AND worker=? ORDER BY rowid DESC LIMIT 1")
      .get(project, worker);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  list(project: string, limit = 200): Run[] {
    return this.db
      .prepare("SELECT data FROM platform_runs WHERE project_id=? ORDER BY rowid DESC LIMIT ?")
      .all(project, limit)
      .map((row) => JSON.parse(String(row.data)));
  }
  /** Cheap running count for one job kind; avoids parsing every Run row. */
  running(project: string, kind: Job["kind"]): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM platform_runs WHERE project_id=? AND kind=? AND status='running'")
      .get(project, kind);
    return Number(row?.n ?? 0);
  }
  hasRunning(project: string, kind?: Job["kind"]): boolean {
    const row = kind
      ? this.db
          .prepare("SELECT 1 FROM platform_runs WHERE project_id=? AND status='running' AND kind=? LIMIT 1")
          .get(project, kind)
      : this.db.prepare("SELECT 1 FROM platform_runs WHERE project_id=? AND status='running' LIMIT 1").get(project);
    return !!row;
  }
  hasUnresolvedAttention(project: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM platform_runs WHERE project_id=? AND status='needs_attention' AND json_extract(data, '$.resolved_at') IS NULL LIMIT 1",
      )
      .get(project);
  }
  save(run: Run) {
    this.db
      .prepare(
        `INSERT INTO platform_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`,
      )
      .run(run.id, run.project_id, run.worker, run.kind, run.node_id, run.status, JSON.stringify(run));
  }
  finish(
    project: string,
    worker: string,
    status: Run["status"],
    error?: string,
    runId?: string,
    failureKind?: Run["failure_kind"],
  ): Run | undefined {
    const run = runId ? this.get(project, runId) : this.worker(project, worker);
    if (!run || run.worker !== worker || run.status !== "running") return run;
    run.status = status;
    run.finished_at = new Date().toISOString();
    if (error) run.error = error.slice(0, 1500);
    if (failureKind && status !== "succeeded" && status !== "cancelled") run.failure_kind = failureKind;
    this.save(run);
    this.db.prepare("DELETE FROM platform_run_models WHERE run_id=?").run(run.id);
    return run;
  }
  receipt(project: string, operation: string, key: string) {
    return this.db
      .prepare(
        "SELECT payload_hash,response FROM platform_receipts WHERE project_id=? AND operation=? AND submission_id=?",
      )
      .get(project, operation, key);
  }
  saveReceipt(project: string, operation: string, key: string, hash: string, response: unknown) {
    this.db
      .prepare("INSERT INTO platform_receipts VALUES(?,?,?,?,?)")
      .run(project, operation, key, hash, JSON.stringify(response));
  }
}
