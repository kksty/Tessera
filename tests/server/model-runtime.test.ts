import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  configuredModel,
  createModelRuntime,
  modelCatalog,
  modelMetadata,
  modelProviders,
  modelSettings,
} from "../../packages/models/src/runtime.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { Store } from "../../packages/core/src/store.js";
import { buildApp } from "../helpers/server.js";
import { sameModelDeployment, type ModelConfig } from "../../packages/protocol/src/model-config.js";

const config = (patch: Partial<ModelConfig> = {}): ModelConfig => ({
  id: "fixture",
  base_url: "http://fixture.invalid/v1",
  api: "openai-completions",
  api_key: "test",
  context_window: 0,
  ...patch,
});

test("an empty native-provider endpoint still counts as the same configured deployment", () => {
  // Legacy Pi-native configs have no base URL. The key reused by /runtime/model-check
  // must still match them, otherwise a stored credential is silently dropped.
  assert.equal(sameModelDeployment("", "", "openai-completions"), true);
  assert.equal(sameModelDeployment("", "https://api.deepseek.com", "openai-completions"), false);
  assert.equal(
    sameModelDeployment("https://api.deepseek.com/v1", "https://api.deepseek.com", "openai-completions"),
    true,
  );
  assert.equal(
    sameModelDeployment("https://api.deepseek.com", "https://api.deepseek.com/v1", "openai-completions"),
    true,
  );
  assert.equal(sameModelDeployment("https://api.other.test", "https://api.deepseek.com", "openai-completions"), false);
});

test("Pi providers and model catalog retain provider identity, native protocol, limits and compatibility", async () => {
  const runtime = await createModelRuntime(),
    providers = await modelProviders();
  for (const id of ["zai", "zai-coding-cn", "deepseek", "minimax", "minimax-cn"]) {
    assert.ok(providers.some((p) => p.id === id));
    const rows = await modelCatalog(config({ provider: id, base_url: "" }));
    assert.ok(rows.length);
    for (const row of rows) {
      const known = runtime.getModel(id, row.id)!;
      assert.equal(row.provider, known.provider);
      assert.equal(row.api, known.api);
      assert.equal(row.context_window, known.contextWindow);
      assert.equal(row.max_output_tokens, known.maxTokens);
      assert.equal(row.reasoning, known.reasoning);
      const registered = await configuredModel(config({ provider: id, id: row.id, base_url: "" }));
      assert.deepEqual(registered.model.compat, known.compat);
      assert.deepEqual(registered.model.thinkingLevelMap, known.thinkingLevelMap);
      assert.deepEqual(registered.model.inputLimits, known.inputLimits);
      assert.equal(registered.model.provider, known.provider);
    }
  }
});

test("custom gateways cannot inherit an unrelated same-ID model or protocol", async () => {
  const native = (await modelCatalog(config({ provider: "minimax", base_url: "" })))[0];
  const custom = await configuredModel(config({ id: native.id, context_window: 16000 }));
  assert.equal(custom.model.api, "openai-completions");
  assert.equal(custom.model.provider, "tessera");
  assert.equal(custom.model.compat, undefined);
  assert.deepEqual(custom.model.input, ["text"]);
  assert.equal(custom.model.contextWindow, 16000);
  // Pi's models.json default output limit, not a Tessera-side window subtraction.
  assert.equal(custom.model.maxTokens, 16384);
  const settings = modelSettings(custom.model).getCompactionSettings(custom.model);
  // Tessera 不再按窗口比例改写压缩预算；完全沿用 Pi 的默认策略。
  assert.deepEqual(settings, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  const metadata = await modelMetadata(config({ id: native.id, context_window: 32000 }));
  assert.deepEqual(metadata.compaction, {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    threshold: 32000 - 16384,
  });
  assert.deepEqual(await modelCatalog(config()), []);
  assert.equal((await modelMetadata(config({ id: native.id }))).context_source, "default");
});

test("Pi applies its custom-model defaults without a Tessera-side output clamp", async () => {
  const tiny = await modelMetadata(config({ context_window: 4096 }));
  assert.equal(tiny.context_window, 4096);
  // Pi's models.json default for an unspecified output limit is 16,384. Pi clamps
  // the actual request against the remaining window; Tessera must not rewrite it.
  assert.equal(tiny.max_output_tokens, 16384);
  // Pi still owns compaction: a window below its 16K reserve yields a non-positive
  // threshold and compacts immediately; the settings page warns about this instead
  // of silently scaling Pi's budget.
  assert.equal(tiny.compaction.reserveTokens, 16384);
  assert.equal(tiny.compaction.threshold, 4096 - 16384);
  const normal = await modelMetadata(config({ context_window: 8192 }));
  assert.equal(normal.max_output_tokens, 16384);
});

test("local custom deployments use Pi compaction defaults unchanged", async () => {
  const local = await modelMetadata(
    config({
      id: "qwen3.8-27b",
      base_url: "http://192.168.0.10:8006/v1",
      context_window: 200000,
      max_output_tokens: 20000,
    }),
  );
  assert.equal(local.provider, "tessera");
  assert.equal(local.context_source, "configured");
  assert.deepEqual(local.compaction, {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    threshold: 200000 - 16384,
  });
});

test("endpoint inference is exact and manual ceilings are respected consistently", async () => {
  const native = (await modelCatalog(config({ provider: "deepseek", base_url: "" })))[0];
  const inferred = await modelMetadata(config({ id: native.id, base_url: native.base_url + "/chat/completions" }));
  assert.equal(inferred.provider, "deepseek");
  assert.equal(inferred.context_source, "pi");
  const ceiling = await modelMetadata(
    config({ provider: "deepseek", id: native.id, context_window: 8192, max_output_tokens: 512 }),
  );
  assert.equal(ceiling.context_window, 8192);
  assert.equal(ceiling.max_output_tokens, 512);
  assert.equal(ceiling.context_source, "configured");
  const mismatch = await modelMetadata(config({ id: native.id, base_url: native.base_url + "/other" }));
  assert.equal(mismatch.provider, "tessera");
  // 官方 OpenAI 兼容端点允许基础地址后追加可选的 /v1（DeepSeek 即如此）：仍按目录识别。
  const withV1 = await modelMetadata(config({ id: native.id, base_url: native.base_url + "/v1" }));
  assert.equal(withV1.provider, "deepseek");
  assert.equal(withV1.context_source, "pi");
  assert.equal(withV1.base_url, native.base_url + "/v1");
  // 目录侧带 /v1、配置侧不带 /v1 是同一个端点的另一种写法（方向也要对称）。
  const hosted = (await modelCatalog(config({ provider: "baseten", base_url: "" })))[0];
  const withoutV1 = await modelMetadata(
    config({
      id: hosted.id,
      provider: "",
      api: hosted.api,
      base_url: hosted.base_url.replace(/\/v1$/, ""),
    }),
  );
  assert.equal(withoutV1.provider, "baseten");
  assert.equal(withoutV1.context_source, "pi");
  const explicit = await modelMetadata(config({ provider: "custom", id: native.id, base_url: native.base_url }));
  assert.equal(explicit.provider, "tessera");
  const mini = (await modelCatalog(config({ provider: "minimax", base_url: "" })))[0];
  // A protocol override is composed from a models.json definition: an unset window
  // is Pi's default, not the catalog value, so the metadata must not claim "pi".
  const overridden = await modelMetadata(
    config({ provider: "minimax", id: mini.id, api: "openai-completions", base_url: mini.base_url }),
  );
  assert.equal(overridden.context_window, 128000);
  assert.equal(overridden.context_source, "default");
  assert.equal(overridden.catalog_match?.context_window, mini.context_window);
  for (const suffix of ["/v1", "/v1/messages", "/v1/messages/"]) {
    const normalized = await modelMetadata(
      config({ provider: "minimax", id: mini.id, api: "anthropic-messages", base_url: mini.base_url + suffix }),
    );
    assert.equal(normalized.base_url, mini.base_url);
  }
});

function completion(reply: any) {
  reply.header("content-type", "text/event-stream");
  const row = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return row({ role: "assistant", content: "OK" }) + row({}, "stop") + "data: [DONE]\n\n";
}

function anthropicCompletion(reply: any) {
  reply.header("content-type", "text/event-stream");
  const events = [
    {
      type: "message_start",
      message: {
        id: "probe",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("API detection uses Pi native transports and reports the exact runner configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-pi-probe-")),
    store = new Store(join(dir, "graph.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"), {}),
    provider = Fastify();
  const app = buildApp(store, runtime, join(dir, "no-web"));
  const calls: any[] = [];
  provider.post("/v1/chat/completions", (req: any, reply) => {
    calls.push({ body: req.body, key: req.headers.authorization });
    const budget = req.body.max_tokens ?? req.body.max_completion_tokens;
    assert.ok(budget > 4000 && budget <= 4096, `probe spends the declared output ceiling, got ${budget}`);
    assert.ok(JSON.stringify(req.body).length > 80000, "probe sends a context sized from the declared window");
    // A regression guard for vocabulary precedence: single characters and stray
    // commas mean the filler no longer tokenizes like real prompt text.
    const prompt: string = req.body.messages.at(-1).content;
    const filler = prompt.slice(0, prompt.indexOf("\n\n"));
    const words = filler.split(" ");
    assert.ok(filler.length > 80000);
    assert.ok(words.length < filler.length / 3, "probe filler uses whole words, not one character per token");
    assert.ok(
      words.every((word: string) => /^[a-z]+(?:-\d+)?$/.test(word)),
      `unexpected probe filler: ${words.slice(0, 5).join(" ")}`,
    );
    return completion(reply);
  });
  provider.post("/anthropic/v1/messages", (req: any, reply) => {
    calls.push({ body: req.body, key: req.headers["x-api-key"] });
    assert.ok(req.body.max_tokens > 4000 && req.body.max_tokens <= 4096);
    assert.ok(JSON.stringify(req.body).length > 80000);
    return anthropicCompletion(reply);
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (const id of ["zai", "deepseek", "minimax"]) {
      const native = (await modelCatalog(config({ provider: id, base_url: "" })))[0];
      const cfg = config({
        provider: id,
        id: native.id,
        api: native.api,
        base_url: provider.listeningOrigin + (id === "minimax" ? "/anthropic" : "/v1"),
        context_window: 32000,
        max_output_tokens: 4096,
      });
      const expected = await configuredModel(cfg);
      const metadata = await app.inject({ method: "POST", url: "/api/runtime/model-metadata", payload: cfg });
      assert.equal(metadata.statusCode, 200, metadata.body);
      assert.deepEqual(metadata.json(), expected.metadata);
      const response = await app.inject({ method: "POST", url: "/api/runtime/model-check", payload: cfg });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().model, expected.metadata);
      assert.deepEqual(response.json().compaction, modelSettings(expected.model).getCompactionSettings(expected.model));
      // The probe reports what it actually spent, not merely that HTTP succeeded.
      const capacity = response.json().capacity;
      assert.equal(capacity.context_window, 32000);
      assert.equal(capacity.output_limit, 4096);
      assert.equal(capacity.context_probe_tokens, 23808);
      assert.ok(capacity.max_tokens > 4000 && capacity.max_tokens <= 4096);
      assert.equal(calls.at(-1).body.model, native.id);
      assert.ok(!response.body.includes('"api_key"'));
    }
    assert.equal(calls.length, 3);
  } finally {
    await app.close();
    await provider.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capacity probe rejects a deployment that answers an oversized request with an empty stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-pi-capacity-")),
    store = new Store(join(dir, "graph.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"), {}),
    provider = Fastify();
  const app = buildApp(store, runtime, join(dir, "no-web"));
  let sent: any;
  provider.post("/v1/chat/completions", (req: any, reply) => {
    sent = req.body;
    // Exactly what this relay's vLLM does when prompt + max_tokens exceeds the real
    // window: 200, one usage-only chunk, [DONE], and no finish_reason anywhere.
    reply.header("content-type", "text/event-stream");
    return `data: ${JSON.stringify({ id: "", model: "fixture", choices: [], usage: { prompt_tokens: 40000, completion_tokens: 0, total_tokens: 40000 } })}\n\ndata: [DONE]\n\n`;
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  try {
    const cfg = config({
      base_url: provider.listeningOrigin + "/v1",
      api_key: "capacity-secret",
      context_window: 200000,
      max_output_tokens: 128000,
    });
    const response = await app.inject({ method: "POST", url: "/api/runtime/model-check", payload: cfg });
    assert.equal(response.statusCode, 422, response.body);
    const detail = response.json().detail as string;
    assert.match(detail, /上下文预算不足/);
    assert.match(detail, /1,?28,?000/); // the output ceiling it really sent
    assert.match(detail, /Stream ended without finish_reason/);
    assert.ok(!response.body.includes("capacity-secret"));
    assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 128000);
    assert.ok(JSON.stringify(sent).length > 100000);
  } finally {
    await app.close();
    await provider.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capacity probe stays inside a small declared window instead of failing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-pi-small-")),
    store = new Store(join(dir, "graph.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"), {}),
    provider = Fastify();
  const app = buildApp(store, runtime, join(dir, "no-web"));
  let sent: any;
  provider.post("/v1/chat/completions", (req: any, reply) => {
    sent = req.body;
    return completion(reply);
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  try {
    // 8192 window with a 4096 ceiling leaves almost no prompt room: the probe must
    // shrink with the declaration, not force a failure of its own making.
    const cfg = config({ base_url: provider.listeningOrigin + "/v1", context_window: 8192, max_output_tokens: 4096 });
    const response = await app.inject({ method: "POST", url: "/api/runtime/model-check", payload: cfg });
    assert.equal(response.statusCode, 200, response.body);
    const capacity = response.json().capacity;
    assert.equal(capacity.context_probe_tokens, 512);
    assert.ok(capacity.max_tokens > 0 && capacity.max_tokens <= 4096);
    assert.ok(JSON.stringify(sent).length < 8000, "small windows get a small probe");
    // A 200K declaration is only probed to the 32K cost ceiling; say so instead of implying full coverage.
    const large = config({
      base_url: provider.listeningOrigin + "/v1",
      context_window: 200000,
      max_output_tokens: 20000,
    });
    const largeResponse = await app.inject({ method: "POST", url: "/api/runtime/model-check", payload: large });
    assert.equal(largeResponse.statusCode, 200, largeResponse.body);
    const largeCapacity = largeResponse.json().capacity;
    assert.equal(largeCapacity.context_probe_tokens, 32768);
    assert.equal(largeCapacity.context_probe_limit, 32768);
    assert.equal(largeCapacity.context_probe_capped, true);
  } finally {
    await app.close();
    await provider.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main/review probes keep account keys scoped, treat keys literally, and redact failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-pi-keys-")),
    store = new Store(join(dir, "graph.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"), {}),
    provider = Fastify();
  const app = buildApp(store, runtime, join(dir, "no-web"));
  let fail = false;
  const keys: unknown[] = [];
  provider.post("/v1/chat/completions", (req: any, reply) => {
    keys.push(req.headers.authorization);
    if (fail) return reply.code(401).send({ error: { message: "Invalid key !literal-$TEST_KEY" } });
    return completion(reply);
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  try {
    const main = config({ base_url: provider.listeningOrigin + "/v1", api_key: "main-key" });
    const review = { ...main, api_key: "!literal-$TEST_KEY" };
    runtime.updatePublic({ model: main, review_model: review });
    for (const scope of ["model", "review_model"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/runtime/model-check",
        payload: { ...main, api_key: "", scope },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(keys, ["Bearer main-key", "Bearer !literal-$TEST_KEY"]);
    fail = true;
    const failure = await app.inject({
      method: "POST",
      url: "/api/runtime/model-check",
      payload: { ...review, api_key: "", scope: "review_model" },
    });
    assert.equal(failure.statusCode, 422);
    assert.ok(!failure.body.includes("!literal-$TEST_KEY"));
    const list = await app.inject({
      method: "POST",
      url: "/api/runtime/models",
      payload: { provider: "minimax", base_url: "", api: "anthropic-messages" },
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(list.json().length);
    assert.ok(list.json().every((m: any) => m.provider === "minimax" && m.api === "anthropic-messages"));
  } finally {
    await app.close();
    await provider.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
