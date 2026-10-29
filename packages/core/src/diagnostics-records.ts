import type { DatabaseSync } from "node:sqlite";
import type { ToolKindUsage, ToolUsage } from "../../protocol/src/tool-usage.js";
import { Diagnostic, RunCost } from "./diagnostics-schema.js";

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
      CREATE INDEX IF NOT EXISTS platform_diagnostic_archive_project ON platform_diagnostic_archive(project_id,seq);
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
  /** 按 Run 聚合诊断事件计数；没有任何事件的 Run 不出现在结果里。 */
  runCosts(project: string, through: number): Map<string, RunCost> {
    const rows = this.db
      .prepare(
        `SELECT run_id,
        SUM(CASE WHEN json_extract(data,'$.type')='tool_start' THEN 1 ELSE 0 END) AS tool_calls,
        SUM(CASE WHEN json_extract(data,'$.type')='compaction_start' THEN 1 ELSE 0 END) AS compactions,
        SUM(CASE WHEN json_extract(data,'$.type')='compaction_anchor' THEN 1 ELSE 0 END) AS anchors,
        SUM(CASE WHEN json_extract(data,'$.type')='compaction_anchor_failed' THEN 1 ELSE 0 END) AS anchor_failures,
        SUM(CASE WHEN json_extract(data,'$.type')='closeout' THEN 1 ELSE 0 END) AS closeouts
      FROM platform_diagnostic_history WHERE project_id=? AND seq<=? GROUP BY run_id`,
      )
      .all(project, through);
    return new Map(
      rows.map((row) => [
        String(row.run_id),
        {
          tool_calls: Number(row.tool_calls),
          compactions: Number(row.compactions),
          anchors: Number(row.anchors),
          anchor_failures: Number(row.anchor_failures),
          closeouts: Number(row.closeouts),
        },
      ]),
    );
  }
  /**
   * 工具调用排行：按 tool_start / tool_end 事件聚合到工具与 Run 类型。
   * 调用次数只数 tool_start；失败数和耗时来自同一工具的 tool_end，缺失事件保持缺失。
   * 归档诊断与热诊断一起统计，老项目不会因为压缩历史就丢掉排行。
   */
  toolUsage(project: string, through: number): ToolUsage[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(d.data,'$.data.tool') AS tool,
        COALESCE(r.kind,'unknown') AS run_kind,
        SUM(CASE WHEN json_extract(d.data,'$.type')='tool_start' THEN 1 ELSE 0 END) AS calls,
        SUM(CASE WHEN json_extract(d.data,'$.type')='tool_end' THEN 1 ELSE 0 END) AS ended,
        SUM(CASE WHEN json_extract(d.data,'$.type')='tool_end'
          AND json_extract(d.data,'$.data.is_error')=1 THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN json_extract(d.data,'$.type')='tool_end'
          AND json_extract(d.data,'$.data.elapsed_ms') IS NOT NULL THEN 1 ELSE 0 END) AS timed,
        SUM(CASE WHEN json_extract(d.data,'$.type')='tool_end'
          THEN COALESCE(json_extract(d.data,'$.data.elapsed_ms'),0) ELSE 0 END) AS elapsed_ms,
        MAX(json_extract(d.data,'$.at')) AS last_at
      FROM platform_diagnostic_history d LEFT JOIN platform_runs r ON r.id=d.run_id
      WHERE d.project_id=? AND d.seq<=?
        AND json_extract(d.data,'$.type') IN ('tool_start','tool_end')
        AND json_extract(d.data,'$.data.tool') IS NOT NULL
      GROUP BY tool, run_kind`,
      )
      .all(project, through);
    const tools = new Map<string, ToolUsage>();
    for (const row of rows) {
      const name = String(row.tool || "");
      if (!name) continue;
      const kind = String(row.run_kind || "unknown") as keyof ToolUsage["by_kind"];
      const bucket: ToolKindUsage = {
        calls: Number(row.calls) || 0,
        ended: Number(row.ended) || 0,
        errors: Number(row.errors) || 0,
        timed: Number(row.timed) || 0,
        elapsed_ms: Number(row.elapsed_ms) || 0,
        last_at: row.last_at ? String(row.last_at) : null,
      };
      if (!bucket.calls && !bucket.ended) continue;
      let tool = tools.get(name);
      if (!tool) {
        tool = { tool: name, calls: 0, ended: 0, errors: 0, timed: 0, elapsed_ms: 0, last_at: null, by_kind: {} };
        tools.set(name, tool);
      }
      tool.calls += bucket.calls;
      tool.ended += bucket.ended;
      tool.errors += bucket.errors;
      tool.timed += bucket.timed;
      tool.elapsed_ms += bucket.elapsed_ms;
      if (bucket.last_at && (!tool.last_at || bucket.last_at > tool.last_at)) tool.last_at = bucket.last_at;
      tool.by_kind[kind] = bucket;
    }
    return [...tools.values()]
      .filter((tool) => tool.calls > 0)
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
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
