import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { observeModel, publicResponse, requestCounters, mergeProviderUsage } from "../../packages/runner/src/model-observer.js";
import { summarizeUsage } from "../../packages/protocol/src/usage.js";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";

test("observer preserves hook arguments, replacements, stream identity and full public text without secrets/reasoning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-observer-"));
  try {
    const text = "正文".repeat(6000);
    let resolveResult!: (m: any) => void;
    const stream = { result: () => new Promise<any>(resolve => { resolveResult = resolve; }) };
    const replacement = { replaced: true };
    const calls: string[] = [];
    const data = { choices: [{ delta: { content: text, reasoning_content: "hidden", api_key: "hidden-key" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } };
    const model = { id: "fixture", api: "openai-completions" } as any;
    const observer = observeModel(async (m, _context, options) => {
      assert.equal(m, model);
      assert.equal(await options?.onPayload?.({}, m), replacement);
      await options?.onResponse?.({ status: 200, headers: { authorization: "Bearer forbidden" } }, m);
      await options?.onProviderStreamEvent?.(data, m);
      return stream as any;
    }, { directory: dir, runId: "run", secrets: ["secret-key"], start: id => calls.push(id),
      complete: (_id, counters) => { assert.equal(counters.cache_read, 0); assert.equal(counters.cache_write, null); calls.push("complete"); },
      failure: () => assert.fail("capture should succeed") });
    const actual = await observer.stream(model, {} as any, {
      onPayload: () => { calls.push("payload"); return replacement; },
      onResponse: () => { calls.push("response"); },
      onProviderStreamEvent: value => { assert.equal(value, data); calls.push("event"); },
    });
    assert.equal(actual, stream);
    resolveResult({ content: [{ type: "thinking", thinking: "hidden-sdk" }, { type: "text", text }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
    await Promise.resolve();
    const rows = readFileSync(join(dir, "model-responses.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.find(r => r.type === "provider_event").data.choices[0].delta.content, text);
    assert.equal(rows.find(r => r.type === "sdk_message").data.content[0].text, text);
    assert.ok(rows.every(r => r.request_id === "request_1"));
    assert.deepEqual(calls, ["request_1", "payload", "response", "event", "complete"]);
    const raw = JSON.stringify(rows);
    for (const secret of ["hidden", "hidden-sdk", "forbidden"]) assert.ok(!raw.includes(secret));
    assert.deepEqual(publicResponse({ text: "secret-key Bearer opaque-key", type: "response.reasoning_text.delta", delta: "hidden" }, ["secret-key"]),
      { type: "response.reasoning_text.delta", omitted: true });
    assert.equal((publicResponse({ text: "secret-key Bearer opaque-key" }, ["secret-key"]) as any).text, "[redacted] Bearer [redacted]");
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request failures retain the exact provider error and do not masquerade as capture write failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-observer-errors-"));
  try {
    const original = new Error("provider disconnected");
    for (const when of ["open", "result"] as const) {
      const failures: { id: string; error: unknown }[] = [];
      const observer = observeModel(async () => {
        if (when === "open") throw original;
        return { result: async () => { throw original; } } as any;
      }, { directory: dir, secrets: [], start: () => {}, complete: () => assert.fail("not a completed response"),
        failure: () => assert.fail("not a capture write failure"), failed: (id, error) => failures.push({ id, error }) });
      if (when === "open") await assert.rejects(async () => { await observer.stream({ id: "fixture", api: "openai-completions" } as any, {} as any, {}); }, (e: unknown) => e === original);
      else { await observer.stream({ id: "fixture", api: "openai-completions" } as any, {} as any, {}); await new Promise(resolve => setImmediate(resolve)); }
      assert.equal(failures.length, 1); assert.equal(failures[0].id, "request_1"); assert.equal(failures[0].error, original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown usage and explicit provider zero remain distinct", () => {
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(requestCounters(empty, undefined), { input: null, input_uncached: null, output: null, cache_read: null, cache_write: null });
  assert.deepEqual(requestCounters(empty, { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }),
    { input: 0, input_uncached: 0, output: 0, cache_read: 0, cache_write: null });
  const start = mergeProviderUsage(undefined, { type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  const delta = mergeProviderUsage(start, { type: "message_delta", usage: { output_tokens: 0 } });
  assert.deepEqual(requestCounters(empty, delta), { input: 0, input_uncached: 0, output: 0, cache_read: 0, cache_write: 0 });
  const response = mergeProviderUsage(undefined, { type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } });
  assert.equal(requestCounters(empty, response).cache_read, 0);
  assert.equal(mergeProviderUsage(response, { type: "response.output_text.delta" }), response);
});

test("capture failures preserve stream behavior and concurrent callbacks retain their own request IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-observer-race-"));
  try {
    const resolvers: ((message: any) => void)[] = [];
    const completed: string[] = [];
    let failures = 0;
    const original = async (_m: any, _c: any, options: any) => {
      await options.onProviderStreamEvent({ choices: [] });
      const result = new Promise<any>(resolve => resolvers.push(resolve));
      return { result: () => result } as any;
    };
    const observer = observeModel(original, { directory: dir, secrets: [], start: () => {},
      complete: id => { completed.push(id); }, failure: () => { failures++; } });
    const model = { id: "fixture", api: "openai-completions" } as any;
    await Promise.all([observer.stream(model, {} as any), observer.stream(model, {} as any)]);
    const message = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "error" };
    resolvers[1](message); resolvers[0](message);
    await Promise.resolve();
    assert.deepEqual(completed, ["request_2", "request_1"]);
    assert.equal(failures, 0);
    const badCapture = observeModel(original, { directory: join(dir, "missing-directory"), secrets: [], start: () => {},
      complete: id => { completed.push(id); }, failure: () => { failures++; } });
    const stream = await badCapture.stream(model, {} as any);
    resolvers[2](message);
    assert.equal(await stream.result(), message);
    assert.equal(failures, 1);
    const failure = new Error("original callback failure");
    await assert.rejects(async () => observer.stream(model, {} as any, { onProviderStreamEvent: () => { throw failure; } }), (e: unknown) => e === failure);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage API keeps legacy totals, disjoint buckets, unknown fields and idempotency through restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-bucket-"));
  let store = new Store(join(dir, "test.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"));
  let app = buildApp(store, runtime, join(dir, "no-web"));
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Usage buckets", origin: "https://example.test", goal: "test" }));
    const id = graph.project.id;
    const job = store.claim(id, "worker", 0)!;
    const revision = store.get(id).observation_revision;
    const post = (payload: object) => app.inject({ method: "POST", url: `/api/projects/${id}/jobs/usage`,
      headers: { "x-tessera-worker-token": testWorkerToken }, payload: { job, ...payload } });
    const started = { request_id: "r1", stage: "started", input: null, output: null, cost: null };
    assert.equal((await post({ ...started, cache_read: 0 })).statusCode, 422);
    assert.equal((await post(started)).statusCode, 200);
    const completed = { request_id: "r1", stage: "completed", input: 100, input_uncached: 50, cache_read: 40, cache_write: 10, output: 20, cost: null };
    assert.equal((await post({ ...completed, input: 99 })).statusCode, 422);
    assert.equal((await post(completed)).statusCode, 200);
    assert.equal((await post(completed)).statusCode, 200);
    assert.equal((await post({ ...completed, cache_read: 41, input_uncached: 49 })).statusCode, 409);
    // Legacy completed request: still total input, no fabricated cache buckets.
    store.usage(id, job, 80, 10, null, "old");
    assert.equal((await post({ request_id: "old", input: 80, output: 10, cost: null })).statusCode, 200);
    assert.equal((await post({ ...started, request_id: "interrupted" })).statusCode, 200);
    await app.close(); store.close();
    store = new Store(join(dir, "test.db"));
    app = buildApp(store, runtime, join(dir, "no-web"));
    assert.equal((await post(completed)).statusCode, 200);
    const run = store.execution.get(id, job.run_id!)!;
    assert.equal(run.request_count, 3);
    assert.equal(run.input, 180);
    assert.equal(run.cache_read, 40);
    assert.equal(run.cache_write, 10);
    assert.equal(run.unknown_request_count, 1);
    assert.equal(run.unknown_breakdown_request_count, 2);
    assert.equal(run.cost, null);
    const totals = summarizeUsage(store.get(id).usage);
    assert.deepEqual(totals.input, { known: 180, unknown: 1 });
    assert.deepEqual(totals.cache_read, { known: 40, unknown: 2 });
    assert.equal(store.get(id).observation_revision, revision);
  } finally {
    await app.close(); store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});
