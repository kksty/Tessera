import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { redactModelError } from "../../protocol/src/model-errors.js";
import { createHash, randomUUID } from "node:crypto";

declare const __TESSERA_BUILD_INFO__: { id: string; version: string; pi_sdk: string };
export const diagnosticBuild =
  typeof __TESSERA_BUILD_INFO__ === "undefined"
    ? { id: "source_unbundled", version: "unknown", pi_sdk: "unknown" }
    : __TESSERA_BUILD_INFO__;

export const diagnosticSchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    source_id: z.string().uuid().optional(),
    source_seq: z.number().int().positive().optional(),
    type: z.enum([
      "run_start",
      "run_end",
      "model_start",
      "model_end",
      "model_request_payload",
      "model_response",
      "model_request_end",
      "model_request_error",
      "model_capture_error",
      "tool_start",
      "tool_end",
      "tool_excerpt",
      "tool_blocked",
      "closeout",
      "result_repair",
      "capacity_plan",
      "context_usage",
      "compaction_start",
      "compaction_end",
      "compaction_anchor",
      "compaction_anchor_failed",
      "validation_trace",
      "validation_trace_limit",
      "result_validation",
      "submission",
      "decision_submission",
      "decision_batch_split",
      "fact_payload_filtered",
      "heartbeat_retry",
    ]),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;

/** Shareable content is separate from runtime input. Preserve JSON syntax while redacting values. */
export function diagnosticValue(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string")
    return diagnosticText(
      value.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "[thinking omitted]"),
      secrets,
      Number.MAX_SAFE_INTEGER,
    );
  if (Array.isArray(value))
    return value
      .filter((item) => !item || !["thinking", "reasoning", "redacted_thinking"].includes(item.type))
      .map((item) => diagnosticValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  if ("type" in value && value.type === "image") {
    const image = value as { type: string; mimeType?: string; data?: string };
    return { type: "image", mimeType: image.mimeType, omitted: true, encoded_chars: image.data?.length ?? null };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:reasoning(?:_content|_details)?|thinking|signature|thinkingSignature|textSignature|encrypted_content|headers)$/i.test(
        key,
      )
        ? "[omitted]"
        : /^(?:authorization|api[_-]?key|cookie|set-cookie|password|passwd|secret|token|x-tessera-worker-token)$/i.test(
              key,
            )
          ? "[redacted]"
          : diagnosticValue(item, secrets),
    ]),
  );
}

/** Explicitly chunk a redacted trace; hashes describe the log copy, never original Evidence. */
export class ValidationTraces {
  chars = 0;
  omitted = 0;
  constructor(
    readonly emit: (type: Diagnostic["type"], data: Record<string, unknown>) => void,
    readonly secrets: string[] = [],
    readonly runLimit = 8 * 1024 * 1024,
    readonly traceLimit = 256 * 1024,
  ) {}
  record(kind: string, value: unknown, context: Record<string, unknown> = {}) {
    try {
      const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
      const cleaned =
        typeof value === "string"
          ? String(diagnosticValue(value, this.secrets))
          : JSON.stringify(diagnosticValue(value, this.secrets));
      const trace_id = randomUUID(),
        available = Math.max(0, Math.min(this.traceLimit, this.runLimit - this.chars));
      const text = cleaned.slice(0, available),
        truncated = text.length < cleaned.length;
      const meta = {
        ...context,
        trace_id,
        kind,
        format: typeof value === "string" ? "text" : "json",
        original_chars: raw.length,
        redacted_chars: cleaned.length,
        recorded_chars: text.length,
        redacted: raw !== cleaned,
        truncated,
        log_sha256: createHash("sha256").update(cleaned).digest("hex"),
      };
      if (!available) {
        this.omitted++;
        // One explicit limit event is enough; keep the normal event stream and final outcome alive.
        if (this.omitted === 1) this.emit("validation_trace_limit", { ...context, kind, limit_chars: this.runLimit });
        return;
      }
      this.chars += text.length;
      const parts = Math.max(1, Math.ceil(text.length / 2000));
      for (let part = 0; part < parts; part++)
        this.emit("validation_trace", {
          ...meta,
          part,
          parts,
          offset: part * 2000,
          content: text.slice(part * 2000, (part + 1) * 2000),
        });
    } catch {
      this.emit("model_capture_error", { stage: "validation_trace", kind });
    }
  }
}

/** Bounded diagnostic excerpts; original artifacts stay in Evidence/workspace. */
export function diagnosticText(value: unknown, secrets: string[] = [], limit = 2048): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return redactModelError(text, secrets)
    .replace(/((?:authorization|cookie|set-cookie)\s*[":=]+\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1[redacted]")
    .slice(0, limit);
}

export class DiagnosticRecords {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS platform_diagnostics(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,event_id));
      CREATE INDEX IF NOT EXISTS platform_diagnostic_project ON platform_diagnostics(project_id,seq);
      CREATE TABLE IF NOT EXISTS platform_diagnostic_archive(
        seq INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,event_id TEXT NOT NULL,data BLOB NOT NULL,
        UNIQUE(run_id,event_id));
      CREATE VIEW IF NOT EXISTS platform_diagnostic_history AS SELECT * FROM platform_diagnostics UNION ALL
        SELECT seq,project_id,run_id,event_id,tessera_inflate(data) AS data FROM platform_diagnostic_archive;`);
  }
  save(project: string, run: string, event: Diagnostic) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO platform_diagnostics(project_id,run_id,event_id,data) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM platform_diagnostic_archive WHERE run_id=? AND event_id=?)",
      )
      .run(project, run, event.id, JSON.stringify({ ...event, received_at: new Date().toISOString() }), run, event.id);
  }
  highwater(project: string): number {
    return Number(
      this.db.prepare("SELECT MAX(seq) AS n FROM platform_diagnostic_history WHERE project_id=?").get(project)?.n || 0,
    );
  }
  page(project: string, after: number, through: number) {
    return this.db
      .prepare(
        "SELECT seq,run_id,data,json_extract(data,'$.received_at') AS received_at FROM platform_diagnostic_history WHERE project_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1000",
      )
      .all(project, after, through)
      .map((row) => ({
        seq: Number(row.seq),
        run_id: String(row.run_id),
        received_at: row.received_at ? String(row.received_at) : null,
        ...JSON.parse(String(row.data)),
      }));
  }
  summaries(project: string, through: number) {
    const runs = this.db
      .prepare(
        `SELECT run_id,COUNT(*) AS events,
      SUM(CASE WHEN json_extract(data,'$.source_id') IS NULL OR json_extract(data,'$.source_seq') IS NULL THEN 1 ELSE 0 END) AS legacy
      FROM platform_diagnostic_history WHERE project_id=? AND seq<=? GROUP BY run_id`,
      )
      .all(project, through);
    const sources = this.db
      .prepare(
        `SELECT run_id,json_extract(data,'$.source_id') AS source_id,
      COUNT(*) AS rows,COUNT(DISTINCT json_extract(data,'$.source_seq')) AS events,
      MIN(json_extract(data,'$.source_seq')) AS first_seq,MAX(json_extract(data,'$.source_seq')) AS last_seq,
      SUM(CASE WHEN json_extract(data,'$.type')='run_start' THEN 1 ELSE 0 END) AS starts,
      SUM(CASE WHEN json_extract(data,'$.type')='run_end' THEN 1 ELSE 0 END) AS ends
      FROM platform_diagnostic_history WHERE project_id=? AND seq<=? AND json_extract(data,'$.source_id') IS NOT NULL
      AND json_extract(data,'$.source_seq') IS NOT NULL GROUP BY run_id,source_id`,
      )
      .all(project, through);
    const types = this.db
      .prepare(
        `SELECT run_id,json_extract(data,'$.type') AS type,COUNT(*) AS n
      FROM platform_diagnostic_history WHERE project_id=? AND seq<=? GROUP BY run_id,type`,
      )
      .all(project, through);
    return runs.map((run) => ({
      type: "run_diagnostic_summary",
      run_id: String(run.run_id),
      event_count: Number(run.events),
      unsequenced_events: Number(run.legacy),
      types: Object.fromEntries(types.filter((t) => t.run_id === run.run_id).map((t) => [String(t.type), Number(t.n)])),
      sources: sources
        .filter((source) => source.run_id === run.run_id)
        .map((source) => {
          const high = Number(source.last_seq),
            count = Number(source.events),
            duplicates = Number(source.rows) - count;
          return {
            source_id: String(source.source_id),
            events: count,
            first_seq: Number(source.first_seq),
            last_seq: high,
            missing_within_observed_range: high - count,
            duplicate_sequences: duplicates,
            has_start: Number(source.starts) > 0,
            has_end: Number(source.ends) > 0,
            sequence_complete:
              Number(source.starts) > 0 && Number(source.ends) > 0 && high === count && duplicates === 0,
            note: Number(source.ends)
              ? "Sequence completeness only; trace truncation and semantic correctness are separate."
              : "Tail unknown: running, interrupted or delivery incomplete.",
          };
        }),
    }));
  }
}
