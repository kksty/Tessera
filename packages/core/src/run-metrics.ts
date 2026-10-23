import type { DatabaseSync } from "node:sqlite";

export function runMetrics(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT kind, COUNT(*) AS runs,
    SUM(status='succeeded') AS succeeded, SUM(status='failed') AS failed,
    SUM(status='running') AS running, SUM(status='needs_attention') AS needs_attention,
    SUM(status='cancelled') AS cancelled, SUM(status='interrupted') AS interrupted,
    SUM(CASE WHEN status!='running' THEN 1 ELSE 0 END) AS finished,
    SUM(CASE WHEN json_extract(data,'$.input') IS NOT NULL AND json_extract(data,'$.output') IS NOT NULL THEN 1 ELSE 0 END) AS known_usage_runs,
    SUM(json_extract(data,'$.input')) AS input_tokens, SUM(json_extract(data,'$.output')) AS output_tokens,
    AVG(CASE WHEN json_extract(data,'$.finished_at') IS NOT NULL THEN
      (julianday(json_extract(data,'$.finished_at'))-julianday(json_extract(data,'$.started_at')))*86400000 END) AS mean_elapsed_ms
    FROM platform_runs GROUP BY kind ORDER BY kind`,
    )
    .all()
    .map((row) => ({
      ...row,
      success_rate: Number(row.finished) ? Number(row.succeeded) / Number(row.finished) : null,
    }));
}
