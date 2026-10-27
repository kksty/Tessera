import { test } from "node:test";
import assert from "node:assert/strict";
import { workerConfig } from "../../apps/dispatcher/src/worker-config.js";
import { configuredModel, modelMetadata } from "../../packages/models/src/runtime.js";
import type { DispatchConfig, Job } from "../../packages/protocol/src/index.js";
import type { ModelConfig } from "../../packages/protocol/src/model-config.js";
import { withModelRelay } from "../../packages/models/src/relay-transport.js";
import { createServer } from "node:http";

test("relay capabilities preserve URL-derived Pi wire compatibility and OpenAI sign-in auth mode", async () => {
  for (const model of [
    {
      provider: "custom",
      base_url: "https://api.z.ai/api/paas/v4",
      api: "openai-completions",
      id: "glm-5",
      api_key: "sk-original",
    },
    {
      provider: "openai",
      base_url: "https://api.openai.com/v1",
      api: "openai-responses",
      id: "gpt-4.1",
      api_key: "access-token",
    },
  ]) {
    const config = { server: "http://control.invalid", model: { ...model, context_window: 32000 } } as DispatchConfig;
    const safe = await workerConfig(
      { kind: "decide", project_id: "project", run_id: "run" } as Job,
      config,
      "dispatcher",
    );
    const payloads: Record<string, unknown>[] = [];
    // The Runner must start from the capacity resolved for the settings page, not
    // re-derive a different fallback from its own catalog snapshot.
    const resolved = await modelMetadata(config.model);
    assert.equal(safe.model.context_window, resolved.context_window);
    assert.equal(safe.model.max_output_tokens, resolved.max_output_tokens);
    for (const cfg of [config.model, safe.model]) {
      const sdk = await configuredModel(cfg);
      await sdk.runtime.completeSimple(
        sdk.model,
        { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
        {
          maxTokens: 16,
          temperature: 0.5,
          maxRetries: 0,
          onPayload: (body) => {
            payloads.push(body as Record<string, unknown>);
          },
          fetch: async () =>
            new Response('{"error":{"message":"fixture stop"}}', {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        },
      );
    }
    for (const field of [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "store",
      "temperature",
      "prompt_cache_options",
      "prompt_cache_retention",
    ])
      assert.deepEqual(payloads[1][field], payloads[0][field], `${model.provider} ${field}`);
    assert.equal(safe.model.base_url, config.model.base_url);
    assert.ok(!JSON.stringify(safe).includes(model.api_key));
  }
});

test("relay routing canonicalizes URL spelling without changing concurrent non-model requests", async () => {
  const server = createServer((req, reply) => {
    req.resume();
    reply.end(req.url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const model = { base_url: base.replace("http:", "HTTP:") + "/original/old/../v1" } as ModelConfig;
    const url = base + "/original/v1/chat/completions";
    const [relayed, direct] = await Promise.all([
      withModelRelay({ base_url: base + "/relay" }, model, async () =>
        (await fetch(url, { method: "POST", body: "{}" })).text(),
      ),
      fetch(url).then((response) => response.text()),
    ]);
    assert.equal(relayed, "/relay/chat/completions");
    assert.equal(direct, "/original/v1/chat/completions");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
