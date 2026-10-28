/**
 * 真实模型 Decide 验收：确认模型实际调用 submit_decisions，并完成 plan + settle。
 *
 * 用法：
 *   npx tsx scripts/checks/decide-model.ts [--timeout 300] [--keep]
 *
 * 模型配置来自 TESSERA_ACCEPTANCE_CONFIG（从平台卷导出的 runtime.json 副本）
 * 或 TESSERA_ACCEPTANCE_MODEL_JSON（单行 JSON）。密钥只用于调用模型，不写入输出。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, type DispatchConfig, type Graph, type Job } from "../../packages/protocol/src/index.js";
import { buildApp, testWorkerToken } from "../../tests/helpers/server.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";
import { acceptanceRuntime } from "./acceptance-config.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const TIMEOUT = option("timeout", 300);
const KEEP = args.includes("--keep");
if (!Number.isSafeInteger(TIMEOUT) || TIMEOUT < 30)
  throw new Error("timeout must be an integer of at least 30 seconds");

const runtime = acceptanceRuntime();
const model = process.env.TESSERA_ACCEPTANCE_MODEL_JSON
  ? JSON.parse(process.env.TESSERA_ACCEPTANCE_MODEL_JSON)
  : runtime.value.model;
if (!model.id || (!model.base_url && !model.provider))
  throw new Error(
    "没有可用模型：设置 TESSERA_ACCEPTANCE_MODEL_JSON，或导出平台卷内的 /data/runtime.json 后用 TESSERA_ACCEPTANCE_CONFIG 指向它",
  );
const config: DispatchConfig = {
  ...runtime.value,
  task_timeout_seconds: TIMEOUT,
  closeout_seconds: Math.max(10, Math.min(60, Math.floor(TIMEOUT / 5))),
  model,
  review_model: runtime.value.review_model?.id ? runtime.value.review_model : undefined,
};

const dir = mkdtempSync(join(tmpdir(), "tessera-decide-real-"));
const store = new Store(join(dir, "graph.db"));
const project = store.create(
  createProjectSchema.parse({
    title: "真实模型 Decide 验收",
    origin: "https://example.test",
    goal: "确认登录入口的认证边界，并给出下一步探索",
  }),
).project;
const id = project.id;
const setup = (round: number) =>
  store.mutate(id, "fixture.setup", true, (g) => {
    g.project.decision_round = round;
  });

// 一块已有材料的黑板：一个已关闭的 Step + 事实、一个待审核 Finding、一个人工 Hint。
const closed = store.manualStep(id, {
  from: ["origin"],
  description: "确认首页与登录入口",
  creator: "human",
  claim: true,
});
const evidence = store.addEvidence(id, {
  title: "登录页响应",
  content: "GET /login -> 200 text/html",
  encoding: "utf8",
  mime_type: "text/plain",
});
const fact = store.fact(id, closed.id, {
  worker: "human",
  description: "GET /login 返回 200 登录表单",
  conclusion: "/login 存在登录表单",
  evidence_ids: [evidence.id],
});
store.manualConclude(id, closed.id, "human", "登录入口已确认");
store.hint(id, "优先确认登录入口；只有证据足够时才关闭问题。", "human", 3);
setup(1);

const app = buildApp(store, runtime, join(dir, "no-web"), testWorkerToken, { auth: false });
await app.listen({ host: "127.0.0.1", port: 0 });
const client = new ApiClient(app.listeningOrigin, testWorkerToken);
const before = store.get(id);
const stepCount = before.steps.length;
const openCount = before.steps.filter((s) => !s.concluded_at && !s.discarded).length;
const job: Job = store.claim(id, "real-decide", 0) as Job;
if (!job || job.kind !== "decide") throw new Error(`没有拿到 Decide job（得到 ${job?.kind ?? "null"}）`);

const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const started = Date.now();
let runError: string | null = null;
try {
  await runJob(job, { ...config, server: app.listeningOrigin }, client, workspace);
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
}
const duration = Date.now() - started;
await app.close();

const after = store.get(id);
const diagnosticsFile = join(workspace, "runs", job.worker, "diagnostics.ndjson");
const diagnostics = existsSync(diagnosticsFile)
  ? readFileSync(diagnosticsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const tools = diagnostics.filter((e) => e.type === "tool_start").map((e) => String(e.data.tool));
const decisions = diagnostics.filter((e) => e.type === "decision_submission").map((e) => e.data);
const run = store.runs(id)[0];
const addedSteps = after.steps.filter((s) => !before.steps.some((old) => old.id === s.id));
const closedNow = after.steps.filter(
  (s) => s.concluded_at && !before.steps.find((old) => old.id === s.id)?.concluded_at,
);
const submitted = decisions.some((d) => d.settle_ok === true);
const report = {
  model: { id: model.id, base_url: model.base_url, api: model.api, context_window: model.context_window },
  duration_ms: duration,
  error: runError,
  run: run ? { status: run.status, input: run.input, output: run.output, requests: run.request_count } : null,
  tools,
  decisions,
  submitted,
  before: { steps: stepCount, open: openCount },
  after: { steps: after.steps.length, open: after.steps.filter((s) => !s.concluded_at && !s.discarded).length },
  added_steps: addedSteps.map((s) => ({
    id: s.id,
    description: s.description,
    priority: s.priority,
    version: s.version,
  })),
  newly_closed: closedNow.map((s) => ({ id: s.id, reason: s.close_reason })),
  decision_round: after.project.decision_round,
  project_status: after.project.status,
  lease_released: after.project.reason === null,
};
console.log(JSON.stringify(report, null, 2));
if (!KEEP) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`临时目录未能删除（可手动清理）：${dir}`);
  }
} else {
  console.log(`保留现场：${dir}`);
}
store.close();
if (runError) process.exitCode = 1;
else if (!decisions.length) process.exitCode = 2;
else if (!submitted) process.exitCode = 3;
