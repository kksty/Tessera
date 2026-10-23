import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, findingSchema, executeSchema, submitDecisionsSchema, type Job } from "../../packages/protocol/src/index.js";
import { Dispatcher } from "../../apps/dispatcher/src/loop.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("Dispatcher cancels exactly deleted Execute/Review tasks, preserving a consumer of a deleted Fact and its scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-deletion-dispatcher-")), store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "Selective cancellation", origin: "https://example.test", goal: "Assess" })).project.id;
  const source = store.manualStep(id, { from: ["origin"], description: "Observe", creator: "human", claim: true });
  const fact = store.fact(id, source.id, { worker: "human", description: "Premise", evidence_ids: [] });
  store.execute(id, source.id, executeSchema.parse({ worker: "human" }));
  store.closeStep(id, source.id, { worker: "human", reason: "Done" });
  const retained = store.manualStep(id, { from: [fact.id], description: "Keep running", creator: "human", priority: 9 });
  const removed = store.manualStep(id, { from: ["origin"], description: "Stop running", creator: "human" });
  const finding = store.submitFinding(id, findingSchema.parse({ title: "Review target", description: "Candidate", from: [fact.id] }));
  const planner = store.claim(id, "initial-planner", 0)!, graph = store.get(id);
  commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision }));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"));
  runtime.update({ ...runtime.value, model: { ...runtime.value.model, id: "fixture", base_url: "http://fixture.invalid/v1" } });
  const app = buildApp(store, runtime, join(dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const started: Job[] = [], aborted: Job[] = [];
  const dispatcher = new Dispatcher(new ApiClient(app.listeningOrigin, testWorkerToken), {
    run: async (job, _config, signal) => new Promise<void>(resolve => {
      started.push(job); signal.addEventListener("abort", () => { aborted.push(job); resolve(); }, { once: true });
    }),
  });
  const config = { ...runtime.value, server: app.listeningOrigin, max_workers: 3, max_project_workers: 4, debounce_ms: deferDecideMs,
    model: { ...runtime.value.model, id: "fixture", base_url: "http://fixture.invalid/v1" } };
  try {
    await dispatcher.tick(config);
    assert.equal(started.length, 3);
    const job = store.claim(id, "deleting-planner", 0);
    // A new observation wakes planning, while the three tasks continue using their leases.
    if (!job) store.hint(id, "Prune selected work");
    const decider = job ?? store.claim(id, "deleting-planner", 0)!;
    const current = store.get(id);
    const result = store.submitDecisions(id, submitDecisionsSchema.parse({ worker: decider.worker, submission_id: "selective-delete",
      revision: current.revision, observation_revision: current.observation_revision, planning_revision: current.planning_revision,
      delete_nodes: [fact.id, removed.id, finding.id].map(id => ({ id, reason: "Selected removal" })) }), decider.run_id);
    assert.equal(result.settle.ok, true);
    config.model.id = ""; // reconcile cancellation without claiming replacement work
    await dispatcher.tick(config);
    await Promise.all([...dispatcher.running.values()].filter(task => task.controller.signal.aborted).map(task => task.promise));
    assert.deepEqual(aborted.map(job => job.step_id ?? job.finding_id).sort(), [removed.id, finding.id].sort());
    assert.ok([...dispatcher.running.values()].some(task => task.job.step_id === retained.id && !task.controller.signal.aborted));
  } finally { await dispatcher.stop(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
