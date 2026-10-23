import { commitPlan } from "../../tests/helpers/current-api.js";
/** Real runner, temporary graph/workspace, synthetic archived records, no target traffic. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { runJob } from "../../packages/runner/src/run.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { buildApp, testWorkerToken } from "../../tests/helpers/server.js";

const root = resolve(import.meta.dirname, "../..");
const runtime = new RuntimeConfig(join(root, "datas/tessera/runtime.json"));
const dir = mkdtempSync(join(tmpdir(), "tessera-capacity-runner-"));
const out = join(root, "test-results", `capacity-runner-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const store = new Store(join(dir, "test.db")), app = buildApp(store, runtime, join(dir, "no-web"));
try {
  const graph = store.create(createProjectSchema.parse({ title: "长 Execute 容量验收", origin: "https://example.test", goal: "只处理合成归档材料，不访问目标" }));
  const ids: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const e = store.addEvidence(graph.project.id, { title: `合成归档 ${i}`, mime_type: "text/plain", encoding: "utf8",
      content: `原始记录 ${i}，唯一标记 FIXTURE-${i}-AMBER。\n` + "这是合成记录的独立行。仅作容量验收，不是真实目标观测；请保留原始编号与引用，不能把重复文本判断为其他记录的证据。".repeat(75) });
    ids.push(e.id);
  }
  const d = store.claim(graph.project.id, "planner", 0)!, snapshot = store.get(graph.project.id);
  commitPlan(store, graph.project.id, decideSchema.parse({ worker: d.worker, revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision,
    steps: [{ from: ["origin"], description: `纯本地验收：用 read_evidence(id,limit=3000) 分别读取 ${ids.join(",")}，允许同批读取。必须实际读取全部15个记录，不能只根据编号猜内容。每个记录输出一个 Fact，准确包含其唯一 FIXTURE 标记，并引用该记录自己的 evidence_ids。无需保存新证据，不执行 shell、网络或写文件；最终 summary 说明读取覆盖及未完成问题。只输出完整 Execute JSON。` }] }));
  const job = store.claim(graph.project.id, "capacity-real", 0)!;
  await app.listen({ host: "127.0.0.1", port: 0 });
  let error: string | undefined;
  try {
    await runJob(job, { ...runtime.value, server: app.listeningOrigin, task_timeout_seconds: 180, closeout_seconds: 20,
      model: { ...runtime.value.model, context_window: 32000 } }, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    // runJob normally reports failure to Dispatcher; this isolated harness owns that release.
    store.release(graph.project.id, job, error);
  }
  const work = join(dir, "runs", job.worker);
  const diagnostics = readFileSync(join(work, "diagnostics.ndjson"), "utf8").trim().split("\n").map(s => JSON.parse(s));
  const responses = readFileSync(join(work, "model-responses.ndjson"), "utf8");
  const result = store.get(graph.project.id), run = store.runs(graph.project.id)[0];
  const coverage = ids.map((id, i) => ({ id, matched: result.facts.some(f => f.description.includes(`FIXTURE-${i + 1}-AMBER`) && f.evidence_ids.includes(id)) }));
  const report = { at: new Date().toISOString(), model: runtime.value.model.id, configured_window: runtime.value.model.context_window,
    experiment_window: 32000, boundary: "Real runner with synthetic archived records; temporary DB/workspace; no target or deployed resources touched",
    error: error ?? null, coverage, run, events: diagnostics.filter(e => ["capacity_plan", "context_usage", "compaction_start", "compaction_end", "result_repair", "closeout"].includes(e.type)) };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "responses.ndjson"), responses);
  console.log(JSON.stringify({ report: join(out, "report.json"), error: error ?? null, matched: coverage.filter(c => c.matched).length,
    summaries: diagnostics.filter(e => e.type === "model_start" && e.data.purpose === "compaction").length, requests: run.request_count }));
  assert.equal(error, undefined);
  assert.ok(coverage.every(c => c.matched));
  assert.ok(diagnostics.some(e => e.type === "compaction_end" && e.data.generation > 0));
  assert.equal(run.status, "succeeded");
} finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
