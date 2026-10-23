import type { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type RetentionPolicy = { events_days: number; diagnostics_days: number; evidence_days: number; batch: number };
export function retentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const number = (key: string, fallback: number) => {
    const raw = env[key];
    if (!raw?.trim()) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(`Invalid ${key}: expected non-negative integer`);
    return Number(raw);
  };
  return {
    events_days: number("TESSERA_EVENT_HOT_DAYS", 90),
    diagnostics_days: number("TESSERA_DIAGNOSTIC_HOT_DAYS", 30),
    evidence_days: number("TESSERA_EVIDENCE_HOT_DAYS", 30),
    batch: Math.max(1, number("TESSERA_ARCHIVE_BATCH", 1000)),
  };
}

/** Lossless cold storage: history remains readable, while old loose files and hot rows are reclaimed. */
export class Retention {
  constructor(
    readonly db: DatabaseSync,
    readonly root: string,
  ) {
    db.function("tessera_inflate", { deterministic: true }, (value) =>
      gunzipSync(value as Uint8Array).toString("utf8"),
    );
    db.exec(`CREATE TABLE IF NOT EXISTS platform_event_archive(
      seq INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,kind TEXT NOT NULL,data BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS archived_event_project ON platform_event_archive(project_id,seq);
      CREATE VIEW IF NOT EXISTS platform_event_history AS SELECT * FROM platform_events UNION ALL
        SELECT seq,project_id,revision,kind,tessera_inflate(data) AS data,created_at FROM platform_event_archive;
      CREATE TABLE IF NOT EXISTS platform_evidence_archive(
        project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(project_id,id));`);
  }
  evidence(project: string, id: string): Buffer | undefined {
    const row = this.db
      .prepare("SELECT data,sha256 FROM platform_evidence_archive WHERE project_id=? AND id=?")
      .get(project, id);
    if (!row) return undefined;
    const bytes = gunzipSync(row.data as Uint8Array);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw new Error("Archived evidence integrity check failed");
    return bytes;
  }
  archive(policy = retentionPolicy(), time = Date.now()) {
    const cutoff = (days: number) => new Date(time - days * 86400000).toISOString();
    let events = 0,
      diagnostics = 0,
      evidence = 0;
    // Archive only inactive projects and completed Runs; live leases are never touched.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (policy.events_days) {
        const rows = this.db
          .prepare(
            `SELECT e.* FROM platform_events e JOIN platform_projects p ON p.id=e.project_id
          WHERE p.status!='active' AND e.created_at<? ORDER BY e.seq LIMIT ?`,
          )
          .all(cutoff(policy.events_days), policy.batch);
        const insert = this.db.prepare("INSERT OR IGNORE INTO platform_event_archive VALUES(?,?,?,?,?,?)");
        for (const row of rows) {
          insert.run(row.seq, row.project_id, row.revision, row.kind, gzipSync(String(row.data)), row.created_at);
          this.db.prepare("DELETE FROM platform_events WHERE seq=?").run(row.seq);
          events++;
        }
      }
      if (
        policy.diagnostics_days &&
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_diagnostics'").get()
      ) {
        const rows = this.db
          .prepare(
            `SELECT d.* FROM platform_diagnostics d JOIN platform_runs r ON r.id=d.run_id
          WHERE r.status!='running' AND json_extract(d.data,'$.received_at')<? ORDER BY d.seq LIMIT ?`,
          )
          .all(cutoff(policy.diagnostics_days), policy.batch);
        const insert = this.db.prepare("INSERT OR IGNORE INTO platform_diagnostic_archive VALUES(?,?,?,?,?)");
        for (const row of rows) {
          insert.run(row.seq, row.project_id, row.run_id, row.event_id, gzipSync(String(row.data)));
          this.db.prepare("DELETE FROM platform_diagnostics WHERE seq=?").run(row.seq);
          diagnostics++;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (policy.evidence_days) {
      const rows = this.db
        .prepare(
          `SELECT r.project_id,r.id,r.data FROM platform_graph_records r JOIN platform_projects p ON p.id=r.project_id
        WHERE r.collection='evidence' AND p.status!='active' AND json_extract(r.data,'$.created_at')<?
        AND NOT EXISTS(SELECT 1 FROM platform_evidence_archive a WHERE a.project_id=r.project_id AND a.id=r.id) LIMIT ?`,
        )
        .all(cutoff(policy.evidence_days), policy.batch);
      for (const row of rows) {
        const file = join(this.root, String(row.project_id), String(row.id));
        if (!existsSync(file)) continue;
        const bytes = readFileSync(file),
          metadata = JSON.parse(String(row.data));
        if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256)
          throw new Error("Evidence integrity check failed before archival");
        // Autocommit the verified bytes before removing the loose copy: crashes can leave a duplicate, never a lost original.
        this.db
          .prepare("INSERT OR IGNORE INTO platform_evidence_archive VALUES(?,?,?,?)")
          .run(row.project_id, row.id, metadata.sha256, gzipSync(bytes));
        unlinkSync(file);
        evidence++;
      }
    }
    return { events, diagnostics, evidence };
  }
}
