import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, type Job } from "../../packages/protocol/src/index.js";
import { memoryEntry, queryMemory, readMemoryRecord } from "../../packages/core/src/memory.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-memory-"));
  const store = new Store(join(dir, "graph.db"));
  const graph = store.create(createProjectSchema.parse({ title: "Memory", origin: "https://example.test", goal: "找回旧前提" }));
  const job: Job = { kind: "decide", project_id: graph.project.id, graph_id: "main", worker: "planner" };
  return { dir, store, graph, job, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the full entry carries every unclosed decision node and a 2000-node long chain", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2000; i++) {
      f.graph.facts.push({ id: `f${i}`, step_id: `i${i}`, conclusion: `结论 ${i}`, status: "observed", description: "长观测".repeat(1000), evidence_ids: [], graph_id: "main" });
      f.graph.steps.push({ id: `i${i}`, description: "探索".repeat(1000), from: [i ? `f${i - 1}` : "origin"], fact_ids: [`f${i}`],
        graph_id: "main", to: null, priority: 1, discarded: false, creator: "fixture", worker: null,
        last_heartbeat_at: null, created_at: "", concluded_at: i === 1999 ? null : "done", summary: "", attempts: 0,
        ...(i === 1999 ? { blocked_run_id: "uncertain-run" } : {}) });
    }
    f.graph.project.hot_limit = 0; // cooling off: the full entry must still carry every fact
    const entry = memoryEntry(f.graph, f.job);
    // No per-kind preview cap and no character budget: every fact is present, every body is cut at a sentence.
    assert.equal(entry.counts.facts, 2001);
    assert.equal(entry.facts.length, 2001);
    assert.equal(entry.steps.length, 1);
    assert.equal(entry.unclosed, 1);
    assert.equal(entry.control.blocked_steps, 1);
    assert.equal(entry.control.unfinished_steps, 1);
    assert.ok(entry.facts.every(line => line.length < 460), "only the body is cut, never the conclusion");
    assert.equal(queryMemory(f.graph, { kind: "steps", status: "blocked" }).items[0].id, "i1999");
    assert.equal(queryMemory(f.graph, { related_to: "i1999", relation: "sources" }).items[0].id, "f1998");
    assert.equal(queryMemory(f.graph, { related_to: "i1999", relation: "outputs" }).items[0].id, "f1999");
    assert.deepEqual(queryMemory(f.graph, { related_to: "f1999", relation: "sources", depth: 1 }).items.map(item => item.id), ["i1999"]);
  } finally { f.close(); }
});

test("history search reaches unmarked old facts, all pages and cross-graph sources", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 240; i++) f.graph.facts.push({ id: `f${i}`, description: i === 0 ? "唯一前提：会话需要 legacy-cookie" : `无关记录 ${i}`,
      graph_id: i < 10 ? "old" : "main", evidence_ids: [], asset_id: "a001" });
    assert.equal(queryMemory(f.graph, { keyword: "legacy-cookie", asset_id: "a001" }).items[0].id, "f0");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = queryMemory(f.graph, { kind: "facts", asset_id: "a001", limit: 17, cursor });
      seen.push(...page.items.map(r => r.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen).size, 241); // Includes the approved origin fact on a001.
    assert.equal(seen.at(-1), "f0", "deterministic created_at desc, id desc ordering");
    const first = queryMemory(f.graph, { kind: "facts", limit: 1 });
    assert.throws(() => queryMemory(f.graph, { kind: "steps", cursor: first.next_cursor! }), /snapshot\/query/);
    f.graph.revision++;
    assert.throws(() => queryMemory(f.graph, { kind: "facts", cursor: first.next_cursor! }), /snapshot\/query/);
  } finally { f.close(); }
});

test("raw JSON pagination preserves every description character and reference without silent truncation", () => {
  const f = fixture();
  try {
    const record = { id: "f-long", description: '原文"\\\n'.repeat(10000), graph_id: "old", evidence_ids: Array.from({ length: 5000 }, (_, i) => `e${i}`) };
    f.graph.facts.push(record);
    let offset = 0, content = "";
    for (;;) {
      const page = readMemoryRecord(f.graph, record.id, offset, 4000);
      assert.ok(page.content!.length <= 4000);
      content += page.content;
      if (page.next_offset === null) break;
      offset = page.next_offset!;
    }
    assert.deepEqual(JSON.parse(content), record);
    const first = readMemoryRecord(f.graph, record.id);
    f.graph.revision++; // Unrelated accounting must not invalidate this record.
    assert.equal(readMemoryRecord(f.graph, record.id, 4000, 4000, first.record_hash).error, undefined);
    record.description += "修订";
    assert.match(readMemoryRecord(f.graph, record.id, 4000, 4000, first.record_hash).error!, /Record changed/);
    assert.throws(() => readMemoryRecord(f.graph, record.id, -1));
  } finally { f.close(); }
});

test("a blocked Step is fully visible in the entry and still prevents completion", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 30; i++) f.store.manualStep(f.graph.project.id, { from: ["origin"], description: `任务 ${i}`, creator: "fixture" });
    f.store.mutate(f.graph.project.id, "step.updated", true, graph => {
      for (const step of graph.steps.slice(0, -1)) step.concluded_at = new Date().toISOString();
      graph.steps.at(-1)!.blocked_run_id = "uncertain-run";
    });
    const job = f.store.claim(f.graph.project.id, "planner", 0)!, graph = f.store.get(f.graph.project.id);
    assert.equal(job.kind, "decide");
    const entry = memoryEntry(graph, job);
    assert.equal(entry.control.blocked_steps, 1);
    const blocked = graph.steps.at(-1)!.id;
    assert.ok(entry.steps.some(line => line.startsWith(blocked)), "the full entry never hides a blocked Step");
    assert.throws(() => commitPlan(f.store, graph.project.id, decideSchema.parse({ worker: job.worker,
      revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      complete: { from: ["origin"], description: "遗漏页面中的阻塞事项" } })), /remaining steps/);
    assert.equal(f.store.get(graph.project.id).project.status, "active");
  } finally { f.close(); }
});

test("Pi tool flow reads an old fact and its original evidence from the full entry", async () => {
  const f = fixture();
  const runtime = new RuntimeConfig(join(f.dir, "runtime.json"));
  const evidence = f.store.addEvidence(f.graph.project.id, { title: "原始前提", content: "legacy-cookie 必须保留", encoding: "utf8", mime_type: "text/plain" });
  f.store.mutate(f.graph.project.id, "fixture.observations", true, graph => {
    for (let i = 0; i < 10; i++) graph.facts.push({ id: `f-prefix${i}`, graph_id: "old", description: `早期其他观测 ${i}`, evidence_ids: [] });
    graph.facts.push({ id: "f-old", graph_id: "old", description: "legacy-cookie 的历史条件", evidence_ids: [evidence.id] });
    for (let i = 0; i < 220; i++) graph.facts.push({ id: `f${i}`, graph_id: "main", description: `其他观测 ${i}`, evidence_ids: [] });
  });
  f.store.mutate(f.graph.project.id, "", false, graph => { graph.decided_revision = graph.observation_revision; });
  f.store.hint(f.graph.project.id, "新问题：核对 legacy-cookie 的历史前提");
  const hintEvent = f.store.events(f.graph.project.id).find(event => event.kind === "hint.added")!;
  const app = buildApp(f.store, runtime, join(f.dir, "no-web"));
  const model = Fastify();
  let calls = 0;
  model.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as { messages: { role: string; content: unknown }[] };
    const toolCall = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    calls++;
    let delta: unknown, finish = "tool_calls";
    if (calls === 1) {
      // The entry is a full summary now: the old fact is part of it, not hidden behind a 5-row preview.
      assert.match(JSON.stringify(body.messages), /f-old/);
      delta = toolCall("query_changes", {});
    } else if (calls === 2) {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === "tool")), /新问题/);
      assert.doesNotMatch(JSON.stringify(body.messages.filter(m => m.role === "tool")), /f-old/);
      delta = toolCall("read_change", { event_seq: hintEvent.seq });
    } else if (calls === 3) {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === "tool")), /hint.added/);
      delta = toolCall("query_graph", { kind: "facts", keyword: "legacy-cookie" });
    }
    else if (calls === 4) {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === "tool")), /f-old/);
      delta = toolCall("read_graph", { id: "f-old" });
    } else if (calls === 5) {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === "tool")), new RegExp(evidence.id));
      delta = toolCall("read_evidence", { id: evidence.id });
    } else {
      assert.match(JSON.stringify(body.messages.filter(m => m.role === "tool")), /必须保留/);
      finish = "stop";
      delta = { content: JSON.stringify({ steps: [{ from: ["f-old"], description: "核对保留 legacy-cookie 时的会话行为" }] }) };
    }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.end(`data: ${JSON.stringify({ id: "memory", choices: [{ index: 0, delta: { role: "assistant", ...delta as object }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "memory", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await model.listen({ host: "127.0.0.1", port: 0 });
  try {
    const job = f.store.claim(f.graph.project.id, "memory-planner", 0)!;
    await runJob(job, { ...runtime.value, server: app.listeningOrigin,
      model: { id: "fixture", base_url: model.listeningOrigin + "/v1", api_key: "test", api: "openai-completions", context_window: 128000 } },
    new ApiClient(app.listeningOrigin, testWorkerToken), f.dir);
    assert.equal(calls, 6);
    assert.deepEqual(f.store.get(f.graph.project.id).steps.at(-1)?.from, ["f-old"]);
  } finally { await model.close(); await app.close(); f.close(); }
});
