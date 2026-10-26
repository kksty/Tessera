import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { createProjectSchema, type DispatchConfig, type Job } from "../../packages/protocol/src/index.js";
import { workerConfig } from "../../apps/dispatcher/src/worker-config.js";
import { modelRunToken, projectToken } from "../../packages/protocol/src/internal-auth.js";
import { configuredModel } from "../../packages/models/src/runtime.js";
import { withModelRelay } from "../../packages/models/src/relay-transport.js";

test("Worker configs contain only the selected Run capability; relay fixes destination and revokes completed Runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-relay-"));
  const upstream = Fastify(),
    store = new Store(join(dir, "db.sqlite"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"));
  let observed: { headers: Record<string, unknown>; body: unknown; path: string } | undefined;
  upstream.post("/*", (req, reply) => {
    observed = { headers: req.headers, body: req.body, path: req.url };
    if ((req.body as any).fail) return reply.code(502).send({ error: "secret-main secret-review" });
    if ((req.body as any).overflow)
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message: "maximum context length exceeded secret-main",
        },
      });
    if (req.url.startsWith("/v1/messages")) {
      const events = [
        {
          type: "message_start",
          message: {
            id: "fixture",
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
      return reply
        .header("content-type", "text/event-stream")
        .send(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    }
    return reply.header("content-type", "text/event-stream").send("data: fixture\n\ndata: [DONE]\n\n");
  });
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(upstream.server.address() as any).port}`;
  const app = buildApp(store, runtime, join(dir, "none"));
  t.after(async () => {
    await app.close();
    await upstream.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.create(
    createProjectSchema.parse({ title: "Relay", origin: "https://example.test", goal: "fixture" }),
  ).project.id;
  const job = store.claim(id, "worker", 0)!;
  assert.equal(job.kind, "decide");
  const config = {
    ...runtime.value,
    server: "http://tessera-server:8000",
    model: {
      ...runtime.value.model,
      provider: "custom",
      base_url: base + "/v1",
      id: "fixture",
      api_key: "secret-main",
      disable_thinking: true,
    },
    review_model: {
      ...runtime.value.model,
      provider: "custom",
      base_url: base + "/review",
      id: "review",
      api_key: "secret-review",
    },
  };
  runtime.value = structuredClone(config);
  const safe = await workerConfig(job, config, testWorkerToken);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes("secret-main") && !serialized.includes("secret-review"));
  assert.equal(safe.review_model, undefined);
  assert.equal(safe.model.api_key, modelRunToken(testWorkerToken, id, job.run_id!));
  const review = await workerConfig({ ...job, kind: "review" }, config, testWorkerToken);
  assert.equal(review.model.id, "review");
  const url = new URL(safe.model_relay!.base_url).pathname + "/chat/completions";
  const request = (
    headers: Record<string, string>,
    body: Record<string, unknown> = { model: "fixture", stream: true },
  ) => app.inject({ method: "POST", url, headers, payload: body });
  for (const credential of [
    "",
    "invalid",
    projectToken(testWorkerToken, id),
    modelRunToken(testWorkerToken, "another", job.run_id!),
  ])
    assert.equal((await request({ authorization: `Bearer ${credential}` })).statusCode, 403);
  const headers = { authorization: `Bearer ${safe.model.api_key}` };
  const response = await request(headers);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /data: fixture/);
  assert.equal(observed!.headers.authorization, "Bearer secret-main");
  // The pinned Run model can turn off the provider reasoning channel; the relay
  // injects it and never lets the worker choose upstream behavior itself.
  assert.equal(((observed!.body as any).chat_template_kwargs ?? {}).enable_thinking, false);
  assert.equal(observed!.path, "/v1/chat/completions");
  assert.equal((await request(headers, { model: "other" })).statusCode, 422);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: url + "?url=http://evil.invalid",
        headers,
        payload: { model: "fixture" },
      })
    ).statusCode,
    404,
  );
  const error = await request(headers, { model: "fixture", fail: true });
  assert.equal(error.statusCode, 502);
  assert.ok(!error.body.includes("secret"));
  const overflow = await request(headers, { model: "fixture", overflow: true });
  assert.equal(overflow.statusCode, 400);
  assert.equal(overflow.json().error.code, "context_length_exceeded");
  assert.equal(overflow.json().error.type, "invalid_request_error");
  assert.match(overflow.json().error.message, /maximum context length exceeded/);
  assert.ok(!overflow.body.includes("secret-main"));
  runtime.value.model = { ...config.model, id: "next-model", api_key: "next-key" };
  assert.equal((await request(headers)).statusCode, 200, "active Run retains its model snapshot after settings change");
  assert.equal(observed!.headers.authorization, "Bearer secret-main");
  runtime.value.model = config.model;
  for (const [api, suffix, key, header] of [
    ["openai-responses", "responses", "secret-main", "authorization"],
    ["anthropic-messages", "v1/messages", "secret-main", "x-api-key"],
    ["anthropic-messages", "v1/messages", "sk-ant-oat-private", "authorization"],
  ]) {
    runtime.value.model = { ...config.model, api, api_key: key, base_url: base };
    const fixture = store.create(
      createProjectSchema.parse({ title: "Protocol", origin: "https://example.test", goal: "fixture" }),
    );
    const protocolJob = store.claim(fixture.project.id, "protocol-worker", 0)!;
    const transport = await workerConfig(protocolJob, runtime.value, testWorkerToken);
    const result = await app.inject({
      method: "POST",
      url: new URL(transport.model_relay!.base_url).pathname + "/" + suffix,
      headers: { [header]: header === "authorization" ? `Bearer ${transport.model.api_key}` : transport.model.api_key },
      payload: { model: "fixture" },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(observed!.headers[header], header === "authorization" ? `Bearer ${key}` : key);
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  const sdkGraph = store.create(
    createProjectSchema.parse({ title: "SDK", origin: "https://example.test", goal: "fixture" }),
  );
  const sdkJob = store.claim(sdkGraph.project.id, "sdk-worker", 0)!;
  const transport = await workerConfig(sdkJob, { ...runtime.value, server: app.listeningOrigin }, testWorkerToken);
  const sdk = await configuredModel(transport.model);
  const answer = await withModelRelay(transport.model_relay, transport.model, () =>
    sdk.runtime.completeSimple(
      sdk.model,
      { messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }] },
      { maxTokens: 16, maxRetries: 0 },
    ),
  );
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.ok(answer.content.some((c) => c.type === "text" && c.text === "OK"));
  assert.equal(observed!.path, "/v1/messages?beta=true");
  assert.equal(observed!.headers["x-app"], "cli");
  const claimedGraph = store.create(
    createProjectSchema.parse({ title: "Claim snapshot", origin: "https://example.test", goal: "fixture" }),
  );
  const claimed = await app.inject({
    method: "POST",
    url: `/api/projects/${claimedGraph.project.id}/jobs/claim`,
    headers: { "x-tessera-worker-token": testWorkerToken },
    payload: { worker: "dispatch", debounce_ms: 0 },
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const dispatched = claimed.json<Job>();
  assert.ok(dispatched.worker_config?.model_relay);
  assert.ok(!claimed.body.includes("sk-ant-oat-private"));
  const frozen = await workerConfig(dispatched, config, testWorkerToken);
  assert.equal(frozen.model.api, "anthropic-messages");
  assert.ok(store.db.prepare("SELECT 1 FROM platform_run_models WHERE run_id=?").get(dispatched.run_id!));
  store.release(claimedGraph.project.id, dispatched);
  assert.equal(store.db.prepare("SELECT 1 FROM platform_run_models WHERE run_id=?").get(dispatched.run_id!), undefined);
  store.release(id, job);
  assert.equal((await request(headers)).statusCode, 409);
});
