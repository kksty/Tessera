import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { CatalogRefresh, createCatalogStore, refreshPublicCatalog } from "../../packages/models/src/catalog-refresh.js";
import { createModelRuntime } from "../../packages/models/src/runtime.js";

test("catalog refresh coalesces reads, respects freshness, and retries failed refreshes", async (t) => {
  let now = Date.now(),
    calls = 0,
    fail = false;
  t.mock.method(Date, "now", () => now);
  const refresh = new CatalogRefresh(
    {
      refresh: async (options) => {
        calls++;
        assert.equal(options?.allowNetwork, true);
        assert.ok(options?.signal);
        if (calls === 3)
          assert.equal(options?.force, true, "retry failures even when Pi's cache freshness interval has not expired");
        if (fail) throw new Error("offline");
        return { aborted: false, errors: new Map() };
      },
    },
    true,
  );
  await Promise.all([refresh.refresh(), refresh.refresh(), refresh.refresh()]);
  assert.equal(calls, 1);
  assert.equal(refresh.status.state, "ready");
  await refresh.refresh();
  assert.equal(calls, 1);
  now += 4 * 60 * 60 * 1000;
  fail = true;
  await refresh.refresh();
  assert.equal(calls, 2);
  assert.equal(refresh.status.state, "failed");
  assert.ok(refresh.status.refreshed_at);
  now += 5 * 60 * 1000;
  fail = false;
  await refresh.refresh();
  assert.equal(calls, 3);
  await refresh.refresh(true);
  assert.equal(calls, 4);
});

test("offline mode never sends catalog requests and partial failures remain visible", async () => {
  let calls = 0;
  const runtime = {
    refresh: async () => {
      calls++;
      return { aborted: false, errors: new Map([["zai", new Error("unavailable")]]) };
    },
  };
  const offline = new CatalogRefresh(runtime, false);
  await offline.refresh(true);
  assert.equal(calls, 0);
  assert.equal(offline.status.state, "offline");
  const partial = new CatalogRefresh(runtime, true);
  await partial.refresh();
  assert.equal(partial.status.state, "partial");
  assert.deepEqual(partial.status.failed_providers, ["zai"]);
});

test("Pi remote catalogs update model limits without sending deployment keys; errors retain the last catalog", async () => {
  const server = Fastify();
  let invalid = false;
  const headers: unknown[] = [];
  const runtime = await createModelRuntime({ catalogBaseUrl: "http://127.0.0.1" });
  const native = runtime.getModels("zai")[0];
  server.get("/api/models/providers/zai", (req, reply) => {
    headers.push(req.headers.authorization, req.headers["x-api-key"]);
    reply.header("last-modified", "Thu, 01 Jan 2099 00:00:00 GMT");
    return invalid
      ? reply.type("application/json").send("{")
      : { models: [{ ...native, contextWindow: 765432, maxTokens: 65536 }] };
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    const store = createCatalogStore();
    const live = await createModelRuntime({ catalogBaseUrl: server.listeningOrigin, modelsStore: store });
    const refresh = new CatalogRefresh(
      { refresh: (options) => refreshPublicCatalog(live, store, { ...options, providers: ["zai"] }) },
      true,
    );
    await refresh.refresh();
    assert.equal(refresh.status.state, "ready");
    assert.equal(headers.length, 2, "the public catalog must actually be requested without a provider credential");
    const refreshed = live.getModel("zai", native.id)!;
    assert.equal(refreshed.contextWindow, 765432);
    assert.equal(refreshed.maxTokens, 65536);
    invalid = true;
    await refresh.refresh(true);
    assert.equal(refresh.status.state, "partial");
    assert.equal(live.getModel("zai", native.id)!.contextWindow, 765432);
    assert.ok(headers.every((value) => value === undefined));
  } finally {
    await server.close();
  }
});
