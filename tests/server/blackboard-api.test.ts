import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";

test("manual close/reopen, cooldown, peek, search and read are wired through HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-blackboard-api-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "API", origin: "https://example.test", goal: "Assess" })).project.id;
  const step = store.manualStep(id, { from: ["origin"], description: "HTTP decision target", creator: "human" });
  store.addEvidence(id, { title: "原始输出", content: "api-needle 正文", encoding: "utf8", mime_type: "text/plain" });
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const worker = { "x-tessera-worker-token": testWorkerToken };
  try {
    const close = await app.inject({ method: "POST", url: `/api/projects/${id}/steps/${step.id}/close`,
      payload: { reason: "答案已足够", expected_version: 1 } });
    assert.equal(close.statusCode, 200, close.body);
    assert.ok(store.get(id).steps[0].concluded_at);
    assert.equal(store.get(id).steps[0].close_reason, "答案已足够");

    const stale = await app.inject({ method: "POST", url: `/api/projects/${id}/steps/${step.id}/reopen`,
      payload: { reason: "新证据", expected_version: 1 } });
    assert.equal(stale.statusCode, 409, stale.body);
    const reopen = await app.inject({ method: "POST", url: `/api/projects/${id}/steps/${step.id}/reopen`,
      payload: { reason: "新证据", expected_version: 2 } });
    assert.equal(reopen.statusCode, 200, reopen.body);
    assert.equal(store.get(id).steps[0].concluded_at, null);
    assert.equal(store.get(id).steps[0].version, 3);

    const rounds = await app.inject({ method: "PUT", url: `/api/projects/${id}/cooldown`, payload: { hot_limit: 0 } });
    assert.equal(rounds.statusCode, 200, rounds.body);
    assert.equal(store.get(id).project.hot_limit, 0);
    const override = await app.inject({ method: "PUT", url: `/api/projects/${id}/cooldown`,
      payload: { node_id: step.id, override: "pinned" } });
    assert.equal(override.statusCode, 200, override.body);
    assert.equal(store.get(id).steps[0].cooldown_override, "pinned");

    // Worker-only routes reject browser/operator requests without the internal token.
    for (const path of ["/fgs/search", "/fgs/peek", "/fgs/read"]) {
      const denied = await app.inject({ method: "POST", url: `/api/projects/${id}${path}`,
        payload: path === "/fgs/search" ? { keyword: "api-needle" } : path === "/fgs/read" ? { id: step.id } : {} });
      assert.equal(denied.statusCode, 403, `${path} must require the worker token`);
    }
    const search = await app.inject({ method: "POST", url: `/api/projects/${id}/fgs/search`, headers: worker,
      payload: { keyword: "api-needle" } });
    assert.equal(search.statusCode, 200, search.body);
    assert.ok(search.json().ids.length >= 1);
    const read = await app.inject({ method: "POST", url: `/api/projects/${id}/fgs/read`, headers: worker,
      payload: { id: step.id } });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(store.get(id).steps[0].last_read_round, 0);
    const peek = await app.inject({ method: "POST", url: `/api/projects/${id}/fgs/peek`, headers: worker, payload: {} });
    assert.equal(peek.statusCode, 200, peek.body);
    assert.equal(peek.json().mode, "peek");
    assert.equal(peek.json().disabled, true, "hot_limit=0 disables browsing");
  } finally {
    await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP observations and discovery bind provenance to the validated lease and replay the original receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-provenance-api-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "Production identity", origin: "https://example.test", goal: "Assess" })).project.id;
  const step = store.manualStep(id, { from: ["origin"], description: "Observe", creator: "human" });
  const planner = store.claim(id, "planner", 0)!, graph = store.get(id);
  commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision }));
  const job = store.claim(id, "executor", 0)!;
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  const headers = { "x-tessera-worker-token": testWorkerToken };
  const submit = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/projects/${id}${url}`,
    headers, payload: { worker: job.worker, run_id: job.run_id, ...payload } });
  try {
    for (const forbidden of [{ step_id: "s999" }, { created_at: "1900-01-01" }]) {
      const spoofed = await submit(`/fgs/steps/${step.id}/facts`, { submission_id: "spoof", description: "Forged metadata", ...forbidden });
      assert.equal(spoofed.statusCode, 422, spoofed.body);
    }
    const payload = { submission_id: "observation", description: "Original observation" };
    const accepted = await submit(`/fgs/steps/${step.id}/facts`, payload);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().step_id, step.id);
    assert.equal(accepted.json().run_id, job.run_id);
    assert.ok(accepted.json().created_at);
    const discovery = await submit("/assets", { submission_id: "discovery", assets: [
      { hostname: "api.example.test", source: "response", evidence_ids: [] },
      { hostname: "third-party.invalid", source: "link", evidence_ids: [] },
    ] });
    assert.equal(discovery.statusCode, 200, discovery.body);
    const after = store.get(id), outputs = after.facts.filter(fact => fact.id !== "origin");
    assert.equal(outputs.length, 3);
    assert.ok(outputs.every(fact => fact.step_id === step.id && fact.run_id === job.run_id && !!fact.created_at));
    assert.deepEqual(after.steps[0].fact_ids, outputs.map(fact => fact.id));
    const external = outputs.find(fact => fact.objects?.includes("third-party.invalid"))!;
    assert.equal(external.asset_id, undefined, "an observed dependency does not inherit authorization");
    const final = await submit(`/fgs/steps/${step.id}/execute`, { submission_id: "final", facts: ["Final observation"] });
    assert.equal(final.statusCode, 200, final.body);
    assert.equal(store.get(id).facts.at(-1)!.run_id, job.run_id);
    const replay = await submit(`/fgs/steps/${step.id}/facts`, payload);
    assert.deepEqual(replay.json(), accepted.json(), "accepted receipts retain the original time and production Run after the lease ends");
    const stale = await submit(`/fgs/steps/${step.id}/facts`, { submission_id: "late", description: "Late observation" });
    assert.equal(stale.statusCode, 409, stale.body);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
