import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { createProjectSchema, findingSchema, type Job } from "../../packages/protocol/src/index.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("claim API uses live server Review limits, clamps to project capacity and preserves existing runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tessera-schedule-api-")), store = new Store(":memory:");
  const runtime = new RuntimeConfig(join(directory, "runtime.json"), {});
  runtime.update({ model: { id: "fixture", base_url: "http://fixture.invalid/v1" }, max_project_workers: 3, max_project_review_workers: 2 });
  const id = store.create(createProjectSchema.parse({ title: "Review capacity", origin: "https://example.test", goal: "Assess" })).project.id;
  for (let i = 0; i < 3; i++) store.submitFinding(id, findingSchema.parse({ title: `Claim ${i}`, description: `Claim ${i}`, from: ["origin"] }));
  const app = buildApp(store, runtime, join(directory, "no-web"));
  const claim = async (worker: string) => {
    const response = await app.inject({ method: "POST", url: `/api/projects/${id}/jobs/claim`,
      headers: { "x-tessera-worker-token": testWorkerToken }, payload: { worker, debounce_ms: deferDecideMs, max_project_review_workers: 32 } });
    assert.equal(response.statusCode, 200);
    return response.json<Job | null>();
  };
  try {
    const first = (await claim("r1"))!, second = (await claim("r2"))!;
    assert.equal(first.finding_id, "v001"); assert.equal(second.finding_id, "v002");
    assert.equal(await claim("capped"), null);
    runtime.update({ max_project_review_workers: 1 });
    assert.doesNotThrow(() => store.heartbeat(id, first));
    assert.doesNotThrow(() => store.heartbeat(id, second));
    store.release(id, first);
    assert.equal(await claim("still-capped"), null);
    store.release(id, second);
    runtime.update({ max_project_workers: 1, max_project_review_workers: 3 });
    assert.equal((await claim("one-slot"))?.kind, "review");
    assert.equal(await claim("project-full"), null);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
