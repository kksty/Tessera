import type { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type {
  TrafficRecord,
  TrafficSummary,
  TrafficStatus,
  trafficRecordSchema,
  trafficStatusSchema,
} from "../../protocol/src/traffic.js";

const normalizeHost = (value: string | undefined) => (value || "").trim().toLowerCase().replace(/:\d+$/, "");

function pathnameOf(value: string): string {
  try {
    return new URL(value, "http://tessera.invalid").pathname;
  } catch {
    return value.split("?")[0];
  }
}

/** 独立于探索图的观测记录，不触发 Decide、不改变观察版本。 */
export class TrafficRecords {
  constructor(
    private db: DatabaseSync,
    private root: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_traffic(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, flow_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, UNIQUE(project_id,flow_id));
      CREATE INDEX IF NOT EXISTS traffic_project_sequence ON project_traffic(project_id,seq DESC);
      CREATE INDEX IF NOT EXISTS traffic_project_step ON project_traffic(project_id,json_extract(data,'$.step_id'));
      CREATE INDEX IF NOT EXISTS traffic_project_run ON project_traffic(project_id,json_extract(data,'$.run_id'));
      CREATE TABLE IF NOT EXISTS project_traffic_status(project_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_traffic_totals(project_id TEXT PRIMARY KEY,count INTEGER NOT NULL,bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO project_traffic_totals SELECT project_id,COUNT(*),SUM(bytes) FROM project_traffic GROUP BY project_id;
      CREATE TRIGGER IF NOT EXISTS traffic_insert AFTER INSERT ON project_traffic BEGIN
        INSERT INTO project_traffic_totals VALUES(NEW.project_id,1,NEW.bytes) ON CONFLICT(project_id) DO UPDATE SET count=count+1,bytes=bytes+NEW.bytes;
      END;
      CREATE TRIGGER IF NOT EXISTS traffic_update AFTER UPDATE ON project_traffic BEGIN
        UPDATE project_traffic_totals SET bytes=bytes+NEW.bytes-OLD.bytes WHERE project_id=NEW.project_id;
      END;
      CREATE TRIGGER IF NOT EXISTS traffic_delete AFTER DELETE ON project_traffic BEGIN
        UPDATE project_traffic_totals SET count=count-1,bytes=bytes-OLD.bytes WHERE project_id=OLD.project_id;
      END;`);
  }
  bodyPath(projectId: string, bodyId: string) {
    // Both identifiers are validated here as this class also has non-HTTP callers.
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^[a-f0-9-]{36}$/i.test(bodyId))
      throw new Error("Invalid traffic body identifier");
    return join(this.root, projectId, "traffic-bodies", bodyId);
  }
  appendBody(projectId: string, bodyId: string, offset: number, data: Buffer) {
    const path = this.bodyPath(projectId, bodyId);
    mkdirSync(join(this.root, projectId, "traffic-bodies"), { recursive: true });
    const fd = openSync(path, existsSync(path) ? "r+" : "wx", 0o600);
    try {
      const size = statSync(path).size;
      if (offset > size) throw new Error("Traffic body upload offset mismatch");
      const overlap = Math.min(data.length, size - offset);
      if (overlap) {
        const previous = Buffer.alloc(overlap);
        if (readSync(fd, previous, 0, overlap, offset) !== overlap || !previous.equals(data.subarray(0, overlap)))
          throw new Error("Traffic body retry differs from saved bytes");
      }
      if (overlap < data.length) {
        let written = overlap;
        while (written < data.length) written += writeSync(fd, data, written, data.length - written, offset + written);
        fsyncSync(fd);
      }
      return { size: statSync(path).size };
    } finally {
      closeSync(fd);
    }
  }
  /** Read the full stored body for a request/response side. */
  messageBody(projectId: string, message: Pick<TrafficRecord["request"], "body_id" | "body_base64">): Buffer {
    if (message.body_id) return readFileSync(this.bodyPath(projectId, message.body_id));
    return Buffer.from(message.body_base64 || "", "base64");
  }
  ingest(projectId: string, records: z.infer<typeof trafficRecordSchema>[]) {
    const insert = this.db.prepare(
      `INSERT INTO project_traffic(project_id,flow_id,created_at,updated_at,data,bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,flow_id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data,bytes=excluded.bytes`,
    );
    let accepted = 0,
      rejected = 0;
    for (const record of records) {
      const old = this.get(projectId, record.id);
      // 延迟重试的 request 不能覆盖已经归档的 response/error。
      if (old && (old.response || old.error) && !record.response && !record.error) continue;
      const data = JSON.stringify(record);
      const { seq: _seq, updated_at: _updated, ...previous } = old || {};
      // Idempotent replay must not depend on a body file that was already archived.
      if (old && JSON.stringify(previous) === data) continue;
      let broken = false;
      for (const message of [record.request, record.response]) {
        if (!message?.body_id) continue;
        try {
          broken ||= statSync(this.bodyPath(projectId, message.body_id)).size !== message.size;
        } catch {
          broken = true;
        }
      }
      // Reject one poisoned record instead of failing the whole batch: the spool
      // would otherwise retry it forever and block every later upload.
      if (broken) {
        rejected++;
        continue;
      }
      insert.run(projectId, record.id, record.created_at, new Date().toISOString(), data, Buffer.byteLength(data));
      accepted++;
    }
    return { accepted, rejected };
  }
  get(projectId: string, id: string): TrafficRecord | null {
    const row = this.db
      .prepare("SELECT seq,updated_at,data FROM project_traffic WHERE project_id=? AND flow_id=?")
      .get(projectId, id) as any;
    return row ? { ...JSON.parse(row.data), seq: Number(row.seq), updated_at: row.updated_at } : null;
  }
  private summary(row: any): TrafficSummary {
    const { request, response, ...record } = JSON.parse(row.data);
    return {
      ...record,
      seq: Number(row.seq),
      updated_at: row.updated_at,
      request_size: request.size,
      response_size: response?.size || 0,
      truncated: request.truncated || !!response?.truncated,
    };
  }
  list(projectId: string, before = 0, limit = 200, query = "", kind = ""): TrafficSummary[] {
    const rows = this.db
      .prepare(
        `SELECT seq,updated_at,data FROM project_traffic WHERE project_id=? AND (?=0 OR seq<?) AND data LIKE ? ESCAPE '\\' AND (?='' OR COALESCE(json_extract(data,'$.capture_kind'),'http')=?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(projectId, before, before, `%${query.replace(/[\\%_]/g, "\\$&")}%`, kind, kind, limit) as any[];
    return rows.map((row) => this.summary(row));
  }
  /** Resolve Finding references in their original order, skipping missing or non-HTTP flows. */
  byIds(projectId: string, ids: string[]): TrafficSummary[] {
    const records: TrafficSummary[] = [];
    const seen = new Set<string>();
    const select = this.db.prepare("SELECT seq,updated_at,data FROM project_traffic WHERE project_id=? AND flow_id=?");
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = select.get(projectId, id) as any;
      if (!row) continue;
      const record = this.summary(row);
      if ((record.capture_kind ?? "http") === "http") records.push(record);
    }
    return records;
  }
  /** HTTP flows recorded for one Step and/or Run, newest first. */
  listForStep(projectId: string, stepId: string | undefined, runId: string | undefined, limit = 200): TrafficSummary[] {
    if (!stepId && !runId) return [];
    const rows = this.db
      .prepare(
        `SELECT seq,updated_at,data FROM project_traffic WHERE project_id=? AND COALESCE(json_extract(data,'$.capture_kind'),'http')='http' AND ((?<>'' AND json_extract(data,'$.step_id')=?) OR (?<>'' AND json_extract(data,'$.run_id')=?)) ORDER BY seq DESC LIMIT ?`,
      )
      .all(projectId, stepId || "", stepId || "", runId || "", runId || "", limit) as any[];
    return rows.map((row) => this.summary(row));
  }
  /**
   * Best-effort match for a Finding whose executor did not cite a flow id.
   * Uses the Step/Run and the Finding's entry surface; the newest exact match
   * wins, while unrelated requests from the same Step stay out when possible.
   */
  suggest(
    projectId: string,
    stepId: string | undefined,
    runId: string | undefined,
    surface: { method?: string; host?: string; path?: string; location?: string } | null | undefined,
    limit = 12,
  ): TrafficSummary[] {
    const rows = this.listForStep(projectId, stepId, runId, 500);
    const method = surface?.method?.trim().toUpperCase() || "";
    const host = normalizeHost(surface?.host);
    const target = surface?.path || surface?.location;
    const expected = target ? pathnameOf(target) : "";
    if (!method && !host && !expected) return rows.slice(0, limit);
    return (
      rows
        .map((record, index) => {
          let score = 0;
          let pathScore = 0;
          if (method && record.method.toUpperCase() === method) score += 4;
          if (host && normalizeHost(record.host) === host) score += 3;
          if (expected) {
            const actual = pathnameOf(record.url);
            if (actual === expected) pathScore = 6;
            else if (actual.startsWith(expected) || expected.startsWith(actual)) pathScore = 2;
            score += pathScore;
          }
          return { record, score, pathScore, index };
        })
        // When the Finding names an entry path, a shared host alone is too weak:
        // keep only flows on that path (or a prefix of it).
        .filter((item) => item.score > 0 && (!expected || item.pathScore > 0))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((item) => item.record)
    );
  }
  status(projectId: string): TrafficStatus {
    const row = this.db.prepare("SELECT data FROM project_traffic_status WHERE project_id=?").get(projectId) as any;
    return row
      ? JSON.parse(row.data)
      : { mode: "proxy", state: "stopped", dropped: 0, blocked: 0, guard: false, last_seen: null };
  }
  setStatus(projectId: string, state: z.infer<typeof trafficStatusSchema>) {
    this.db
      .prepare("INSERT OR REPLACE INTO project_traffic_status VALUES(?,?)")
      .run(projectId, JSON.stringify({ ...state, mode: "proxy", last_seen: new Date().toISOString() }));
    return { ok: true };
  }
  remove(projectId: string) {
    this.db.prepare("DELETE FROM project_traffic WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM project_traffic_status WHERE project_id=?").run(projectId);
    this.db.prepare("DELETE FROM project_traffic_totals WHERE project_id=?").run(projectId);
  }
}
