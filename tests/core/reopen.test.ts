import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, executeSchema } from "../../packages/protocol/src/index.js";
test("execute ends the run but not the question; reopen reruns it", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({
      title: "Reopen", origin: "https://example.test", goal: "Verify the ambiguous condition",
    })).project.id;
    const planner = store.claim(id, "planner", 0)!;
    let graph = store.get(id);
    commitPlan(store, id, decideSchema.parse({
      worker: planner.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      steps: [{ from: ["origin"], description: "Check whether the condition is enough" }],
    }));

    const executor = store.claim(id, "executor", 0)!;
    assert.equal(executor.kind, "execute");
    const stepId = executor.step_id!;
    store.execute(id, stepId, executeSchema.parse({ worker: executor.worker, facts: ["Observed a partial result"], summary: "Partial" }));

    let step = store.get(id).steps.find((value) => value.id === stepId)!;
    assert.ok(step.executed_at);
    assert.equal(step.concluded_at, null, "execution must not close the question");

    // The executor cannot claim it again; the decider must see it first.
    const closer = store.claim(id, "planner", 0)!;
    assert.notEqual(closer.kind, "execute");
    assert.equal(closer.kind, "decide");
    graph = store.get(id);
    commitPlan(store, id, decideSchema.parse({
      worker: closer.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      closes: [{ id: stepId, expected_version: store.get(id).steps.find(s => s.id === stepId)!.version ?? 1, reason: "The partial result is not enough", evidence_ids: [] }],
    }));
    step = store.get(id).steps.find((value) => value.id === stepId)!;
    assert.ok(step.concluded_at);
    assert.equal(step.close_reason, "The partial result is not enough");
    assert.equal(step.discarded, false);

    // A human hint starts a new decision lease; reopen clears both timestamps and discards.
    store.hint(id, "Reconsider the closed question", "human");
    const reopener = store.claim(id, "planner", 0)!;
    assert.equal(reopener.kind, "decide");
    graph = store.get(id);
    commitPlan(store, id, decideSchema.parse({
      worker: reopener.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      reopens: [{ id: stepId, expected_version: store.get(id).steps.find(s => s.id === stepId)!.version ?? 1, reason: "The requirement is ambiguous; retry with a narrower probe" }],
    }));

    step = store.get(id).steps.find((value) => value.id === stepId)!;
    assert.equal(step.concluded_at, null);
    assert.equal(step.executed_at, null);
    assert.equal(step.discarded, false);
    assert.equal(step.summary, "");
    assert.equal(step.worker, null);

    const retry = store.claim(id, "executor-2", 0)!;
    assert.equal(retry.kind, "execute");
    assert.equal(retry.step_id, stepId);
  } finally {
    store.close();
  }
});

test("a human can close and reopen a Step without holding a Decide lease", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Manual close", origin: "https://example.test", goal: "Assess" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Ambiguous question", creator: "human" });
    const closed = store.closeStep(id, step.id, { worker: "human", reason: "Answer is sufficient for now" });
    assert.ok(closed.concluded_at);
    assert.equal(closed.close_reason, "Answer is sufficient for now");
    assert.equal(closed.version, 2);
    assert.throws(() => store.closeStep(id, step.id, { worker: "human", reason: "again" }), /already concluded/);
    assert.throws(() => store.closeStep(id, step.id, { worker: "human", reason: "again", expected_version: 1 }), /already concluded/);
    const reopened = store.reopenStep(id, step.id, { worker: "human", reason: "New evidence contradicts the close", expected_version: 2 });
    assert.equal(reopened.concluded_at, null);
    assert.equal(reopened.executed_at, null);
    assert.equal(reopened.close_reason, undefined);
    assert.equal(reopened.version, 3);
    assert.throws(() => store.reopenStep(id, step.id, { worker: "human", reason: "again" }), /Only a concluded/);
    // The reopened Step is schedulable again once the pending decision is settled.
    const planner = store.claim(id, "planner", 0)!;
    assert.equal(planner.kind, "decide");
    const graph = store.get(id);
    commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision }));
    assert.equal(store.claim(id, "executor", 0)!.step_id, step.id);
  } finally { store.close(); }
});
