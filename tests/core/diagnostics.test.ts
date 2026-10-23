import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Store } from "../../packages/core/src/store.js";
import { DiagnosticRecords, diagnosticText, diagnosticValue, diagnosticSchema, ValidationTraces, type Diagnostic } from "../../packages/core/src/diagnostics.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";

test("diagnostic export correlates Runs, deduplicates late events, pages all records and supports incremental export without waking Decide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-diagnostics-"));
  const store = new Store(join(dir, "test.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Diagnostics", origin: "https://example.test", goal: "test" }));
    const job = store.claim(graph.project.id, "planner", 0)!;
    const revision = store.get(graph.project.id).observation_revision;
    const event = { id: randomUUID(), at: new Date().toISOString(), type: "tool_end", data: { tool_call_id: "c1", tool: "read_graph", is_error: true, result_excerpt: "bad parameter" } };
    const post = (payload: unknown, token = testWorkerToken) => app.inject({ method: "POST", url: `/api/projects/${graph.project.id}/jobs/diagnostics`, headers: { "x-tessera-worker-token": token, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    assert.equal((await post({ job, event }, "wrong")).statusCode, 403);
    assert.equal((await post({ job: { ...job, worker: "other" }, event })).statusCode, 409);
    assert.equal((await post({ job, event })).statusCode, 200);
    store.release(graph.project.id, job);
    assert.equal((await post({ job, event })).statusCode, 200, "a terminal Run accepts delayed diagnostics");
    const records = new DiagnosticRecords(store.db);
    for (let i = 0; i < 1003; i++) records.save(graph.project.id, job.run_id!, { ...event, id: randomUUID(), type: "model_start", data: { request_id: `r${i}` } });
    const response = await app.inject(`/api/projects/${graph.project.id}/diagnostics`);
    assert.equal(response.statusCode, 200);
    const rows = gunzipSync(response.rawPayload).toString().trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.filter(r => r.seq).length, 1004);
    assert.equal(rows.filter(r => r.type === "tool_end").length, 1);
    assert.equal(rows.find(r => r.type === "run_snapshot").status, "cancelled");
    const cursor = rows.at(-1).next_after;
    const incremental = await app.inject(`/api/projects/${graph.project.id}/diagnostics?after=${cursor}`);
    const next = gunzipSync(incremental.rawPayload).toString().trim().split("\n").map(line => JSON.parse(line));
    assert.equal(next.filter(r => r.seq).length, 0);
    assert.equal(store.get(graph.project.id).observation_revision, revision);
    assert.equal((await app.inject(`/api/projects/${graph.project.id}/diagnostics?after=-1`)).statusCode, 422);
  } finally {
    await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostic excerpts redact configured credentials and common secret fields before bounding output", () => {
  const result = diagnosticText({ command: "scan --password=supersecret --token=tokenvalue", key: "configured-secret", authorization: "Bearer bearer-secret" }, ["configured-secret"]);
  for (const secret of ["supersecret", "tokenvalue", "configured-secret", "bearer-secret"]) assert.ok(!result.includes(secret));
  assert.equal(diagnosticText("x".repeat(10000)).length, 2048);
});

test("validation traces reconstruct full redacted JSON, omit reasoning/images and explicitly bound chunks and run totals", () => {
  const events: { type: Diagnostic["type"]; data: Record<string, any> }[] = [];
  const traces = new ValidationTraces((type, data) => events.push({ type, data }), ["configured-secret"]);
  const input = { content: "原文\u0000\"\\".repeat(1800), password: "private-password", nested: { token: "private-token" },
    public: "configured-secret", reasoning_content: "hidden-reasoning",
    blocks: [{ type: "thinking", thinking: "hidden-block" }, { type: "text", text: "<think>hidden-inline</think>公开正文" },
      { type: "image", mimeType: "image/png", data: "private-image" }] };
  traces.record("memory_tool", input, { generation: 2 });
  assert.ok(events.length > 2);
  for (const e of events) {
    const event = diagnosticSchema.parse({ id: randomUUID(), at: new Date().toISOString(), ...e });
    assert.ok(JSON.stringify(event).length <= 16000);
    assert.equal(e.data.truncated, false); assert.equal(e.data.redacted, true);
  }
  const text = events.map(e => e.data.content).join("");
  assert.equal(text.length, events[0].data.redacted_chars);
  assert.equal(createHash("sha256").update(text).digest("hex"), events[0].data.log_sha256);
  assert.deepEqual(JSON.parse(text), diagnosticValue(input, ["configured-secret"]));
  for (const secret of ["private-password", "private-token", "configured-secret", "hidden-reasoning", "hidden-block", "hidden-inline", "private-image"])
    assert.ok(!text.includes(secret));
  assert.equal(input.password, "private-password", "runtime input is never changed");
  events.length = 0;
  const bounded = new ValidationTraces((type, data) => events.push({ type, data }), [], 10, 6);
  bounded.record("a", "abcdefgh"); bounded.record("b", "abcdefgh"); bounded.record("c", "lost"); bounded.record("d", "lost");
  assert.equal(bounded.chars, 10); assert.equal(bounded.omitted, 2);
  assert.ok(events.filter(e => e.type === "validation_trace").every(e => e.data.truncated));
  assert.equal(events.filter(e => e.type === "validation_trace_limit").length, 1);
});

test("v2 batch export detects sequence gaps, missing tails and legacy/no-data runs without changing graph state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-diagnostics-v2-")), store = new Store(join(dir, "test.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Trace", origin: "https://example.test", goal: "verify" }));
    const job = store.claim(graph.project.id, "planner", 0)!;
    const revision = store.get(graph.project.id).revision, source = randomUUID(), recovery = randomUUID();
    const event = (seq: number, type: Diagnostic["type"], source_id = source): Diagnostic => ({
      id: randomUUID(), at: new Date().toISOString(), source_id, source_seq: seq, type, data: {} });
    const payload = { job, events: [event(1, "run_start"), event(3, "tool_end"), event(4, "run_end"),
      event(1, "run_start", recovery), event(2, "run_end", recovery)] };
    const post = (body: unknown) => app.inject({ method: "POST", url: `/api/projects/${graph.project.id}/jobs/diagnostics`,
      headers: { "x-tessera-worker-token": testWorkerToken }, payload: body as any });
    assert.equal((await post({ ...payload, job: { ...job, graph_id: "wrong" } })).statusCode, 409);
    assert.equal((await post(payload)).statusCode, 200);
    assert.equal((await post(payload)).statusCode, 200, "batch replay remains idempotent");
    const records = new DiagnosticRecords(store.db), before = records.highwater(graph.project.id);
    assert.equal((await post({ job, events: [event(5, "tool_end"), { ...event(6, "tool_end"), data: { text: "x".repeat(17000) } }] })).statusCode, 422);
    assert.equal(records.highwater(graph.project.id), before, "oversized batch cannot partially persist");
    records.save(graph.project.id, job.run_id!, { id: randomUUID(), at: new Date().toISOString(), type: "tool_end", data: {} });
    const decode = async (after = 0) => {
      const response = await app.inject(`/api/projects/${graph.project.id}/diagnostics?after=${after}`);
      return gunzipSync(response.rawPayload).toString().trim().split("\n").map(line => JSON.parse(line));
    };
    const rows = await decode(), summary = rows.find(r => r.type === "run_diagnostic_summary");
    assert.equal(rows[0].schema, "tessera.diagnostics.v2");
    assert.equal(summary.event_count, 6); assert.equal(summary.unsequenced_events, 1);
    const gapped = summary.sources.find((s: any) => s.source_id === source), complete = summary.sources.find((s: any) => s.source_id === recovery);
    assert.equal(gapped.missing_within_observed_range, 1); assert.equal(gapped.sequence_complete, false);
    assert.equal(complete.sequence_complete, true);
    assert.deepEqual((await decode(rows.at(-1).next_after)).find(r => r.type === "run_diagnostic_summary"), summary);
    const tail = randomUUID(); await post({ job, events: [event(1, "run_start", tail)] });
    assert.equal((await decode()).find(r => r.type === "run_diagnostic_summary").sources.find((s: any) => s.source_id === tail).has_end, false);
    assert.equal(store.get(graph.project.id).revision, revision);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
