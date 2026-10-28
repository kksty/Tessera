/** Read-only operational observations; deliberately omits targets, transcripts and credentials. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { db: { type: "string" }, output: { type: "string" }, project: { type: "string" } },
});
if (!values.db || !values.output)
  throw new Error(
    "Usage: tsx scripts/checks/project-observation.ts --db <tessera.db 副本> --output NEW_DIRECTORY [--project ID]\n" +
      "平台库在命名卷里：先 docker run --rm -v tessera-data:/data -v ${PWD}:/out alpine cp /data/tessera.db /out/ 导出。",
  );
const db = new DatabaseSync(resolve(values.db!), { readOnly: true });
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const errorKind = (text: string) =>
  /502|upstream_error/.test(text)
    ? "provider_502"
    : /impact evidence/i.test(text)
      ? "impact_evidence_validation"
      : /cvss.*null/i.test(text)
        ? "cvss_null_protocol"
        : /Read-only recovery/i.test(text)
          ? "recovery_write_rejected"
          : /Finding revised/i.test(text)
            ? "finding_revision_cancelled"
            : text
              ? "other"
              : null;
const sum = (rows: Record<string, any>[], key: string) => ({
  known: rows.reduce((n, row) => n + (count(row[key]) ?? 0), 0),
  unknown: rows.filter((row) => count(row[key]) === null).length,
});

try {
  db.exec("BEGIN");
  const at = new Date().toISOString();
  const highwater = Number(db.prepare("SELECT MAX(seq) AS n FROM platform_diagnostics").get()?.n ?? 0);
  const sourceProjects = db
    .prepare("SELECT id,status,data FROM platform_projects ORDER BY id")
    .all()
    .filter((row) => !values.project || row.id === values.project);
  if (!sourceProjects.length) throw new Error("No selected project");
  const projects = sourceProjects.map((row) => {
    const graph = JSON.parse(String(row.data));
    const runs = db
      .prepare("SELECT data FROM platform_runs WHERE project_id=? ORDER BY rowid")
      .all(String(row.id))
      .map((row) => JSON.parse(String(row.data)));
    const diagnostics = new Map(
      runs.map((run) => [
        run.id,
        {
          build: null as unknown,
          model: null as unknown,
          types: {} as Record<string, number>,
          tools: {} as Record<string, number>,
          duplicate_tool_arguments: 0,
          repairs: 0,
          compacted: 0,
          truncated_traces: new Set<string>(),
          toolFingerprints: new Set<string>(),
          observed_requests: 0,
          model_elapsed_ms: 0,
        },
      ]),
    );
    for (const eventRow of db
      .prepare("SELECT run_id,data FROM platform_diagnostics WHERE project_id=? AND seq<=? ORDER BY seq")
      .iterate(String(row.id), highwater)) {
      const d = JSON.parse(String(eventRow.data)),
        record = diagnostics.get(String(eventRow.run_id));
      if (!record) continue;
      record.types[d.type] = (record.types[d.type] ?? 0) + 1;
      if (d.type === "run_start") {
        record.build = d.data.build;
        record.model = d.data.model;
      }
      if (d.type === "result_repair") record.repairs++;
      if (d.type === "compaction_end" && !d.data.aborted && !d.data.error) record.compacted++;
      if (d.type === "validation_trace" && d.data.truncated) record.truncated_traces.add(d.data.trace_id);
      if (d.type === "model_request_end") {
        record.observed_requests++;
        record.model_elapsed_ms += count(d.data.elapsed_ms) ?? 0;
      }
      if (d.type === "tool_start") {
        record.tools[d.data.tool] = (record.tools[d.data.tool] ?? 0) + 1;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([d.data.tool, d.data.args_excerpt]))
          .digest("hex");
        if (record.toolFingerprints.has(fingerprint)) record.duplicate_tool_arguments++;
        record.toolFingerprints.add(fingerprint);
      }
    }
    const records = runs.map((run) => {
      const d = diagnostics.get(run.id)!;
      const finished = run.finished_at && Number.isFinite(Date.parse(run.finished_at));
      return {
        id: run.id,
        kind: run.kind,
        node_id: run.node_id,
        attempt: run.attempt,
        status: run.status,
        started_at: run.started_at,
        finished_at: run.finished_at,
        duration_ms: finished ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null,
        input: count(run.input),
        output: count(run.output),
        cost: count(run.cost),
        request_count: run.request_count,
        unknown_usage_requests: run.unknown_request_count ?? null,
        unknown_cache_breakdown_requests: run.unknown_breakdown_request_count ?? null,
        peak_context: run.capacity?.peak ?? null,
        error_kind: errorKind(run.error ?? ""),
        build: d.build,
        model: d.model,
        repairs: d.repairs,
        compactions: d.compacted,
        tool_counts: d.tools,
        repeated_argument_calls: d.duplicate_tool_arguments,
        truncated_traces: d.truncated_traces.size,
        diagnostic_types: d.types,
        observed_requests: d.observed_requests,
        model_elapsed_ms: d.model_elapsed_ms,
      };
    });
    const byRole = ["decide", "execute", "review"].map((kind) => {
      const rows = records.filter((run) => run.kind === kind);
      return {
        kind,
        runs: rows.length,
        statuses: Object.fromEntries(
          [...new Set(rows.map((r) => r.status))].map((status) => [
            status,
            rows.filter((r) => r.status === status).length,
          ]),
        ),
        input: sum(rows, "input"),
        output: sum(rows, "output"),
        cost: sum(rows, "cost"),
        requests: sum(rows, "request_count"),
        worker_ms: sum(rows, "duration_ms"),
        repairs: sum(rows, "repairs").known,
      };
    });
    return {
      project_id: row.id,
      status: row.status,
      graph_sha256: createHash("sha256").update(String(row.data)).digest("hex"),
      counts: Object.fromEntries(
        ["facts", "steps", "findings", "evidence", "reviews"].map((key) => [key, graph[key].length]),
      ),
      by_role: byRole,
      runs: records,
    };
  });
  const result = {
    recorded_at: at,
    diagnostic_highwater: highwater,
    mode: "read_only_snapshot",
    projects,
    limitations: [
      "Observed projects are not a controlled M6 comparison.",
      "Running attempts and their totals are provisional.",
      "Missing costs and cache breakdowns remain unknown; do not treat missing values as zero.",
      "Repeated argument excerpts are candidates for inspection, not proof of wasted action.",
      "Server diagnostic gaps may have additional records in the original workspace.",
    ],
  };
  writeFileSync(join(output, "observation.json"), JSON.stringify(result, null, 2));
  const lines = [
    "# 实际任务观测",
    "",
    `记录时间：${at}；诊断快照水位：${highwater}。只读提取，未新增模型调用。`,
    "",
    "这些项目的目标、代码版本及运行条件不同，统计用于定位问题，不据此判断改造收益。",
    "",
    "| 项目 | 状态 | 角色 | Run 数 | 请求数 | 已知输入 tokens | 已知输出 tokens | 未知费用 Run 数 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const project of projects)
    for (const role of project.by_role)
      lines.push(
        `| ${project.project_id} | ${project.status} | ${role.kind} | ${role.runs} | ${role.requests.known} | ${role.input.known} | ${role.output.known} | ${role.cost.unknown} |`,
      );
  lines.push(
    "",
    "原始命令、目标、请求正文、证据正文和凭据未写入这份摘要。运行中的数据为快照；日志截断、缺失或重复参数需要结合具体 Run 检查。",
    "",
    "旧样本的优先排查项：Execute 上下文累积与多轮请求、上游 502 导致的受阻执行、审核影响证明校验、空 CVSS 的结果序列化。当前代码已改变分类与提示词，旧失败不能直接判定为新版缺陷。",
    "",
  );
  writeFileSync(join(output, "observation.md"), lines.join("\n"));
  process.stdout.write(
    JSON.stringify({
      output,
      projects: projects.map((p) => ({ id: p.project_id, status: p.status, runs: p.runs.length })),
    }) + "\n",
  );
  db.exec("ROLLBACK");
} finally {
  db.close();
}
