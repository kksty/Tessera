/**
 * 历史找回真实模型验收；边界见 docs/project.md，固定场景与判断留在本脚本。
 *
 * 固定场景与 tests/core/memory.test.ts 的模拟 Pi 工具链用例一致：
 *   1. 图早期保存唯一包含隐藏前提的事实 f-old 及其原始 Evidence，不标星；
 *   2. 其后再写入 220 条无关事实，f-old 不进入 Decide 入口的分页预览；
 *   3. 追加一个能由关键词定位前提的新问题 Hint；
 *   4. 用真实模型跑一次 Decide，检查它是否经“变化入口 → 查询 → 节点 → Evidence → 正确引用”找回旧记录。
 *
 * 用法：
 *   pnpm exec tsx scripts/checks/memory-model.ts [--runs 3] [--timeout 900] [--keep]
 *
 * 模型配置来自 TESSERA_ACCEPTANCE_CONFIG（从平台卷导出的 runtime.json 副本）
 * 或 TESSERA_ACCEPTANCE_MODEL_JSON（单行 JSON）。密钥只用于调用模型，不写入任何输出。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, type DispatchConfig, type Graph, type Job } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import type { ModelConfig } from "../../packages/protocol/src/model-config.js";
import { buildApp, testWorkerToken } from "../../tests/helpers/server.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";
import { acceptanceRuntime } from "./acceptance-config.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const RUNS = option("runs", 3);
const TASK_TIMEOUT_SECONDS = option("timeout", 900);
const KEEP = args.includes("--keep");
const BOOKMARK_COMPARISON = args.includes("--bookmark-comparison");
type BookmarkMode = "none" | "active" | "withdrawn";
if (!Number.isSafeInteger(RUNS) || RUNS < 1 || !Number.isSafeInteger(TASK_TIMEOUT_SECONDS) || TASK_TIMEOUT_SECONDS < 3)
  throw new Error("runs must be a positive integer and timeout must be an integer of at least 3 seconds");

const repoRoot = resolve(import.meta.dirname, "../..");
const EXPECTED_FACT_ID = "f-old";
const EVIDENCE_CONTENT = "legacy-cookie 必须保留";
const EVIDENCE_TITLE = "原始前提";
const PREMISE_DESCRIPTION = "legacy-cookie 的历史条件";
const NEW_QUESTION = "新问题：核对 legacy-cookie 的历史前提";

interface RunReport {
  bookmark_mode: BookmarkMode;
  run_usage?: unknown;
  run: number;
  worker: string;
  started_at: string;
  duration_ms: number;
  model: { id: string; base_url: string; api: string; context_window: number };
  error: string | null;
  entry: {
    chars: number;
    counts: Record<string, number>;
    control: Record<string, number>;
    leaks_fact_id: boolean;
    leaks_premise_description: boolean;
    leaks_evidence_content: boolean;
    hint_visible: boolean;
  };
  tool_calls: { name: string; args: unknown; is_error: boolean; result_chars: number }[];
  retrieval: {
    used_change_entry: boolean;
    read_change_event: boolean;
    queried_graph: boolean;
    keyword: string | null;
    found_fact_in_query_result: boolean;
    read_fact_record: boolean;
    read_original_evidence: boolean;
  };
  decision: {
    submitted: boolean;
    submission_state: string | null;
    rejected_status: number | null;
    cited_ids: string[];
    cites_expected_fact: boolean;
    cited_distractor_ids: string[];
    cited_unknown_ids: string[];
    evidence_ids_in_from: string[];
    steps: number;
    updates: number;
    goals: number;
    complete: boolean;
    payload_excerpt: string;
  };
  usage: {
    requests: number;
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
  };
  repair_attempts: number;
  verdict: "通过" | "部分通过（未回读原始证据）" | "漏查" | "错误引用" | "引用遗漏" | "协议提交失败" | "运行失败";
  notes: string[];
}

/**
 * 取“已记录模型配置”的有效值：持久 runtime.json 可能省略 api 等字段，
 * 由 RuntimeConfig 按与部署相同的方式补齐默认值和校验。
 */
function loadModelConfig(): ModelConfig {
  const env = process.env.TESSERA_ACCEPTANCE_MODEL_JSON;
  if (env) {
    const parsed = JSON.parse(env) as Partial<ModelConfig>;
    return { api: "openai-completions", base_url: "", context_window: 0, ...parsed } as ModelConfig;
  }
  const model = acceptanceRuntime().value.model;
  if (!model.id || (!model.base_url && !model.provider) || !model.api_key)
    throw new Error(
      "配置里缺少模型 ID、API 地址或 API Key：检查导出的 runtime.json，或用 TESSERA_ACCEPTANCE_MODEL_JSON 提供模型配置",
    );
  return model as ModelConfig;
}

function readNdjson(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** Builds the fixed acceptance scenario: one hidden early premise plus 220 later distractors. */
function scenario(store: Store, run: number, mode: BookmarkMode) {
  const graph = store.create(
    createProjectSchema.parse({
      title: `历史找回真实模型验收 ${run}`,
      origin: "https://example.test",
      goal: "找回图早期保存的唯一前提，并引用其原始证据后再规划",
    }),
  );
  const project = graph.project.id;
  const evidence = store.addEvidence(project, {
    title: EVIDENCE_TITLE,
    content: EVIDENCE_CONTENT,
    encoding: "utf8",
    mime_type: "text/plain",
  });
  store.mutate(project, "acceptance.observations", true, (g) => {
    for (let i = 0; i < 10; i++)
      g.facts.push({ id: `f-prefix${i}`, graph_id: "old", description: `早期其他观测 ${i}`, evidence_ids: [] });
    g.facts.push({
      id: EXPECTED_FACT_ID,
      graph_id: "old",
      description: PREMISE_DESCRIPTION,
      evidence_ids: [evidence.id],
    });
    for (let i = 0; i < 220; i++)
      g.facts.push({ id: `f${i}`, graph_id: "main", description: `其他观测 ${i}`, evidence_ids: [] });
  });
  if (mode !== "none") {
    const seed = store.claim(project, `bookmark-seed-${run}`, 0)!;
    const input = {
      worker: seed.worker,
      node_id: EXPECTED_FACT_ID,
      expected_version: 0,
      reason: "后续问题可能需要核对这里的原始条件",
      revisit_when: "新问题涉及相同访问条件时",
      withdraw: false,
    };
    store.bookmark(project, seed.run_id!, input);
    if (mode === "withdrawn") store.bookmark(project, seed.run_id!, { ...input, expected_version: 1, withdraw: true });
    store.release(project, seed);
  }
  // 把已写入的历史记为已处理：新 Decide 的变化窗口只包含下面这条新问题。
  store.mutate(project, "", false, (g) => {
    g.decided_revision = g.observation_revision;
  });
  store.hint(project, NEW_QUESTION);
  return { project, evidenceId: evidence.id };
}

function failure(error: unknown): { message: string; isApi: boolean; status?: number } {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    return { message: error.message, isApi: typeof status === "number", status };
  }
  return { message: String(error), isApi: false };
}

async function runOnce(
  run: number,
  model: ModelConfig,
  outputDir: string,
  mode: BookmarkMode = "none",
): Promise<RunReport> {
  const dir = mkdtempSync(join(tmpdir(), `tessera-memory-real-${run}-`));
  const workdir = join(dir, "workspace");
  mkdirSync(workdir, { recursive: true });
  const worker = `memory-planner-${run}`;
  const store = new Store(join(dir, "graph.db"));
  const report: RunReport = {
    bookmark_mode: mode,
    run,
    worker,
    started_at: new Date().toISOString(),
    duration_ms: 0,
    model: { id: model.id, base_url: model.base_url, api: model.api, context_window: model.context_window },
    error: null,
    entry: {
      chars: 0,
      counts: {},
      control: {},
      leaks_fact_id: false,
      leaks_premise_description: false,
      leaks_evidence_content: false,
      hint_visible: false,
    },
    tool_calls: [],
    retrieval: {
      used_change_entry: false,
      read_change_event: false,
      queried_graph: false,
      keyword: null,
      found_fact_in_query_result: false,
      read_fact_record: false,
      read_original_evidence: false,
    },
    decision: {
      submitted: false,
      submission_state: null,
      rejected_status: null,
      cited_ids: [],
      cites_expected_fact: false,
      cited_distractor_ids: [],
      cited_unknown_ids: [],
      evidence_ids_in_from: [],
      steps: 0,
      updates: 0,
      goals: 0,
      complete: false,
      payload_excerpt: "",
    },
    usage: { requests: 0, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
    repair_attempts: 0,
    verdict: "运行失败",
    notes: [],
  };
  let graph: Graph | undefined;
  let evidenceId = "";
  try {
    const seeded = scenario(store, run, mode);
    evidenceId = seeded.evidenceId;
    const runtime = new RuntimeConfig(join(dir, "runtime.json"));
    const project = seeded.project;
    const job = store.claim(project, worker, 0);
    if (!job || job.kind !== "decide") throw new Error(`领取到的不是 Decide 任务: ${job?.kind ?? "null"}`);
    const app = buildApp(store, runtime, join(dir, "no-web"));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const config: DispatchConfig = {
      server: app.listeningOrigin,
      worker_image: "tessera-runtime:0.3.0",
      network: "tessera-network",
      volume_prefix: "tessera",
      max_workers: 1,
      max_project_workers: 1,
      interval_ms: 2000,
      debounce_ms: 0,
      task_timeout_seconds: TASK_TIMEOUT_SECONDS,
      closeout_seconds: Math.min(60, Math.floor(TASK_TIMEOUT_SECONDS / 3)),
      tool_timeout_seconds: 90,
      result_repairs: 1,
      model: { ...model, api: model.api as DispatchConfig["model"]["api"] },
    };
    const started = Date.now();
    try {
      await runJob(job as Job, config, new ApiClient(app.listeningOrigin, testWorkerToken), workdir);
    } catch (error) {
      const info = failure(error);
      report.error = `${info.message}${info.status ? ` (HTTP ${info.status})` : ""}`;
      store.release(project, job, report.error);
    } finally {
      report.duration_ms = Date.now() - started;
      await app.close();
    }
    graph = store.get(project);
    const recordedRun = store.runs(project).find((r) => r.id === job.run_id);
    report.run_usage = recordedRun
      ? {
          status: recordedRun.status,
          requests: recordedRun.request_count,
          input: recordedRun.input,
          input_uncached: recordedRun.input_uncached ?? null,
          cache_read: recordedRun.cache_read ?? null,
          cache_write: recordedRun.cache_write ?? null,
          output: recordedRun.output,
          cost: recordedRun.cost,
          unknown_request_count: recordedRun.unknown_request_count ?? null,
        }
      : null;
    collectEvidence(report, { store, project, workdir, worker, job: job as Job, evidenceId, graph, outputDir, run });
  } catch (error) {
    const info = failure(error);
    report.error = report.error ?? `${info.message}${info.status ? ` (HTTP ${info.status})` : ""}`;
    if (!report.decision.payload_excerpt) collectPartial(report, workdir, worker);
  } finally {
    store.close();
    if (KEEP) report.notes.push(`工作目录保留: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(join(outputDir, `run-${run}.json`), JSON.stringify(report, null, 2));
  return report;
}

function collectPartial(report: RunReport, workdir: string, worker: string) {
  const runDir = join(workdir, "runs", worker);
  report.entry.chars = existsSync(join(runDir, "view.json"))
    ? readFileSync(join(runDir, "view.json"), "utf8").length
    : 0;
  report.tool_calls = readNdjson(join(runDir, "tools.ndjson")).map((t) => ({
    name: String(t.toolName ?? ""),
    args: t.args,
    is_error: Boolean(t.isError),
    result_chars: textOf(t.result).length,
  }));
}

/** 保存可复核的原始轨迹：入口、工具轨迹、诊断、用量与最终提交记录。 */
function preserveArtifacts(runDir: string, destDir: string) {
  mkdirSync(destDir, { recursive: true });
  for (const file of [
    "view.json",
    "tools.ndjson",
    "diagnostics.ndjson",
    "usage.ndjson",
    "model-responses.ndjson",
    "pending-result.json",
  ])
    if (existsSync(join(runDir, file))) copyFileSync(join(runDir, file), join(destDir, file));
  const reference = join(runDir, "pending-result.json");
  if (!existsSync(reference)) return;
  const pointer = JSON.parse(readFileSync(reference, "utf8")) as { submission_file?: string };
  if (!pointer.submission_file) return;
  const source = join(runDir, pointer.submission_file);
  if (!existsSync(source)) return;
  mkdirSync(join(destDir, "submissions"), { recursive: true });
  copyFileSync(source, join(destDir, "submissions", pointer.submission_file.split("/").at(-1) ?? "submission.json"));
}

function collectEvidence(
  report: RunReport,
  ctx: {
    store: Store;
    project: string;
    workdir: string;
    worker: string;
    job: Job;
    evidenceId: string;
    graph: Graph;
    outputDir: string;
    run: number;
  },
) {
  const { workdir, worker, evidenceId, graph, outputDir, run } = ctx;
  const runDir = join(workdir, "runs", worker);
  const viewFile = join(runDir, "view.json");
  const viewRaw = existsSync(viewFile) ? readFileSync(viewFile, "utf8") : "";
  const view = viewRaw ? (JSON.parse(viewRaw) as { view?: Record<string, unknown> }) : {};
  const entry = (view.view ?? {}) as {
    counts?: Record<string, number>;
    control?: Record<string, number>;
    changes?: unknown;
  };
  report.entry.chars = viewRaw.length;
  report.entry.counts = entry.counts ?? {};
  report.entry.control = entry.control ?? {};
  report.entry.leaks_fact_id = new RegExp(`\\b${EXPECTED_FACT_ID}\\b`).test(viewRaw);
  report.entry.leaks_premise_description = viewRaw.includes(PREMISE_DESCRIPTION);
  report.entry.leaks_evidence_content = viewRaw.includes(EVIDENCE_CONTENT);
  report.entry.hint_visible = viewRaw.includes("legacy-cookie");

  const tools = readNdjson(join(runDir, "tools.ndjson"));
  report.tool_calls = tools.map((t) => ({
    name: String(t.toolName ?? ""),
    args: t.args,
    is_error: Boolean(t.isError),
    result_chars: textOf(t.result).length,
  }));
  const callArgs = (t: Record<string, unknown>) => (t.args ?? {}) as Record<string, unknown>;
  report.retrieval.used_change_entry = tools.some((t) => t.toolName === "query_changes");
  report.retrieval.read_change_event = tools.some((t) => t.toolName === "read_change");
  const queries = tools.filter((t) => t.toolName === "query_graph");
  report.retrieval.queried_graph = queries.length > 0;
  const keyword = queries
    .map((t) => callArgs(t).keyword)
    .find((k) => typeof k === "string" && String(k).includes("legacy-cookie"));
  report.retrieval.keyword = typeof keyword === "string" ? keyword : null;
  report.retrieval.found_fact_in_query_result = queries.some((t) => textOf(t.result).includes(EXPECTED_FACT_ID));
  report.retrieval.read_fact_record = tools.some(
    (t) => t.toolName === "read_graph" && callArgs(t).id === EXPECTED_FACT_ID,
  );
  report.retrieval.read_original_evidence = tools.some(
    (t) => t.toolName === "read_evidence" && callArgs(t).id === evidenceId,
  );

  for (const event of readNdjson(join(runDir, "diagnostics.ndjson"))) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "result_repair") report.repair_attempts++;
    if (event.type === "model_end") {
      report.usage.requests++;
      report.usage.input_tokens += Number(data.input ?? 0);
      report.usage.cache_read_tokens += Number(data.cache_read ?? 0);
      report.usage.cache_write_tokens += Number(data.cache_write ?? 0);
      report.usage.output_tokens += Number(data.output ?? 0);
    }
  }

  const reference = join(runDir, "pending-result.json");
  if (existsSync(reference)) {
    const pointer = JSON.parse(readFileSync(reference, "utf8")) as { submission_file?: string };
    const submissionFile = join(runDir, pointer.submission_file ?? "");
    if (pointer.submission_file && existsSync(submissionFile)) {
      const record = JSON.parse(readFileSync(submissionFile, "utf8")) as {
        payload?: Record<string, unknown>;
        state?: string;
        rejected_status?: number;
      };
      const payload = record.payload ?? {};
      report.decision.submission_state = record.state ?? null;
      report.decision.rejected_status = record.rejected_status ?? null;
      report.decision.submitted = record.state === "accepted" || record.state === "pending";
      report.decision.payload_excerpt = JSON.stringify(payload).slice(0, 4000);
      const steps = Array.isArray(payload.steps) ? (payload.steps as Record<string, unknown>[]) : [];
      const updates = Array.isArray(payload.updates) ? (payload.updates as unknown[]) : [];
      const goals = Array.isArray(payload.goals) ? (payload.goals as unknown[]) : [];
      report.decision.steps = steps.length;
      report.decision.updates = updates.length;
      report.decision.goals = goals.length;
      report.decision.complete = Boolean(payload.complete);
      const cited = new Set<string>();
      for (const step of steps) for (const id of (step.from as string[] | undefined) ?? []) cited.add(String(id));
      const complete = payload.complete as { from?: string[] } | undefined;
      for (const id of complete?.from ?? []) cited.add(String(id));
      report.decision.cited_ids = [...cited];
      const known = new Set(graph.facts.map((f) => f.id));
      report.decision.cites_expected_fact = cited.has(EXPECTED_FACT_ID);
      report.decision.cited_distractor_ids = [...cited].filter((id) => /^f\d+$/.test(id));
      report.decision.cited_unknown_ids = [...cited].filter(
        (id) => id !== "origin" && !known.has(id) && !/^e\d+$/.test(id),
      );
      report.decision.evidence_ids_in_from = [...cited].filter((id) => /^e\d+$/.test(id));
    }
  }

  /**
   * 必须实际查询找回旧记录、回读原始证据，并在决策中准确引用。
   * （from 只接受 fact 编号；引用被服务端拒绝同样记为错误引用，而不是重复探索失败）。
   */
  const citedWrong = report.decision.cited_distractor_ids.length + report.decision.cited_unknown_ids.length;
  const rejected = report.decision.submission_state === "rejected" || report.decision.rejected_status !== null;
  if (!report.decision.payload_excerpt) {
    report.verdict = "运行失败";
    report.error = report.error ?? "Decide 未留下最终提交记录";
  } else if (report.error && report.decision.evidence_ids_in_from.length) {
    report.verdict = "错误引用";
    report.notes.push("from 混入证据编号 e###，被服务端按引用规则拒绝。");
  } else if (report.error && rejected) {
    report.verdict = citedWrong ? "错误引用" : "协议提交失败";
    report.notes.push(`提交被服务端拒绝：${report.error}`);
  } else if (report.error) {
    report.verdict = "运行失败";
  } else if (
    report.decision.cites_expected_fact &&
    report.retrieval.read_fact_record &&
    report.retrieval.read_original_evidence &&
    !citedWrong
  ) {
    report.verdict = "通过";
  } else if (
    report.decision.cites_expected_fact &&
    (!report.retrieval.read_fact_record || !report.retrieval.read_original_evidence)
  ) {
    report.verdict = "部分通过（未回读原始证据）";
  } else if (report.decision.cites_expected_fact && citedWrong) {
    report.verdict = "错误引用";
  } else if (citedWrong || report.decision.evidence_ids_in_from.length) {
    report.verdict = "错误引用";
  } else if (
    report.retrieval.read_fact_record &&
    report.retrieval.read_original_evidence &&
    !report.decision.cites_expected_fact
  ) {
    report.verdict = "引用遗漏";
    report.notes.push("已回读旧节点与原始证据，但最终 from 未引用旧事实，文字提及不构成结构化来源。");
  } else {
    report.verdict = "漏查";
  }
  preserveArtifacts(runDir, join(outputDir, `run-${run}-artifacts`));
}

function summarize(reports: RunReport[]) {
  const lines = [
    "# 历史找回真实模型验收",
    "",
    `运行次数：${reports.length}；书签场景：${reports.map((r) => r.bookmark_mode).join(", ")}`,
    "",
  ];
  lines.push(
    "| 次数 | 判定 | 变化入口 | 关键词查询 | 命中 f-old | 回读节点 | 回读证据 | 引用 f-old | 提交状态 | 工具调用 | 修复 | 耗时 s |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of reports) {
    lines.push(
      `| ${r.run} | ${r.verdict} | ${r.retrieval.used_change_entry ? "是" : "否"} | ${r.retrieval.keyword ?? (r.retrieval.queried_graph ? "有查询/无关键词" : "无")} | ${r.retrieval.found_fact_in_query_result ? "是" : "否"} | ${r.retrieval.read_fact_record ? "是" : "否"} | ${r.retrieval.read_original_evidence ? "是" : "否"} | ${r.decision.cites_expected_fact ? "是" : "否"} | ${r.decision.submission_state ?? "无"}${r.decision.rejected_status ? `(${r.decision.rejected_status})` : ""} | ${r.tool_calls.length} | ${r.repair_attempts} | ${(r.duration_ms / 1000).toFixed(1)} |`,
    );
  }
  lines.push("", "## 逐次错误与备注", "");
  for (const r of reports) {
    const notes = [r.error, ...r.notes].filter(Boolean);
    lines.push(`- 第 ${r.run} 次：${notes.length ? notes.join("；") : "无"}`);
  }
  lines.push("", "## 入口泄漏检查", "");
  for (const r of reports)
    lines.push(
      `- 第 ${r.run} 次：入口 ${r.entry.chars} 字符；含 f-old=${r.entry.leaks_fact_id}；含前提描述=${r.entry.leaks_premise_description}；含证据正文=${r.entry.leaks_evidence_content}；含新问题关键词=${r.entry.hint_visible}`,
    );
  lines.push("", "## 引用明细", "");
  for (const r of reports)
    lines.push(
      `- 第 ${r.run} 次引用：${r.decision.cited_ids.length ? r.decision.cited_ids.join(", ") : "（无）"}${r.decision.cited_unknown_ids.length ? `；未知 ID：${r.decision.cited_unknown_ids.join(", ")}` : ""}${r.decision.evidence_ids_in_from.length ? `；from 中出现证据 ID：${r.decision.evidence_ids_in_from.join(", ")}` : ""}`,
    );
  lines.push("", "## 用量与工具轨迹", "");
  for (const r of reports) {
    lines.push(
      `- 第 ${r.run} 次：${r.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(" → ") || "（无工具调用）"}`,
    );
    lines.push(
      `  用量：请求 ${r.usage.requests}；input ${r.usage.input_tokens}；cache_read ${r.usage.cache_read_tokens}；output ${r.usage.output_tokens}`,
    );
  }
  return lines.join("\n");
}

const model = loadModelConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(repoRoot, "test-results", "memory-real-model", stamp);
mkdirSync(outputDir, { recursive: true });
console.log(`模型: ${model.id} @ ${model.base_url} api=${model.api} context_window=${model.context_window}`);
const totalRuns = BOOKMARK_COMPARISON ? RUNS * 3 : RUNS;
console.log(`验收运行 ${totalRuns} 次，输出目录: ${outputDir}\n`);

const reports: RunReport[] = [];
for (let run = 1; run <= totalRuns; run++) {
  const mode: BookmarkMode = BOOKMARK_COMPARISON ? (["none", "active", "withdrawn"] as const)[(run - 1) % 3] : "none";
  console.log(`--- 第 ${run}/${totalRuns} 次（${mode}） ---`);
  const report = await runOnce(run, model, outputDir, mode);
  reports.push(report);
  console.log(
    `判定: ${report.verdict}；工具: ${report.tool_calls.map((c) => c.name).join(" → ") || "无"}；引用: ${report.decision.cited_ids.join(", ") || "无"}${report.error ? `；错误: ${report.error}` : ""}\n`,
  );
}
writeFileSync(join(outputDir, "summary.md"), summarize(reports));
writeFileSync(
  join(outputDir, "summary.json"),
  JSON.stringify({ model: { ...model, api_key: "" }, runs: reports }, null, 2),
);
console.log(summarize(reports));
console.log(`\n结果目录: ${outputDir}`);
if (reports.some((r) => r.verdict !== "通过")) process.exitCode = 1;
