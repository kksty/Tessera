import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { graphElements } from "../../apps/web/src/Blackboard.js";
import { promptFor } from "../../packages/runner/src/prompts.js";

const create = (store: Store, title = "Workbench") => store.create(createProjectSchema.parse({ title, origin: "https://example.test", goal: "Assess", hints: [{ content: "Prioritize existing evidence" }] }));

test("identical reports reuse their immutable snapshot", () => {
  const store = new Store(":memory:");
  try {
    const id = create(store).project.id, reports = new Reports(store);
    const first = reports.create(id), revision = store.get(id).revision;
    assert.equal(reports.create(id).id, first.id);
    assert.equal(store.get(id).revision, revision);
    assert.equal(reports.list(id).length, 1);
    assert.equal(reports.get(id, first.id).id, first.id);
    store.rename(id, "Updated report title");
    assert.notEqual(reports.create(id).source_hash, first.source_hash);
    assert.equal(reports.list(id).length, 2);
    assert.equal(reports.list(id)[1].stale, true);
  } finally { store.close(); }
});

test("continuation is rejected by the decision contract and absent from prompts", () => {
  const store = new Store(":memory:");
  try {
    const first = create(store, "First"), second = create(store, "Second");
    store.manualStep(first.project.id, { from: ["origin"], description: "Running first project", creator: "human", claim: true });
    const job = store.claim(second.project.id, "second-planner", 0)!;
    const snapshot = store.get(second.project.id);
    assert.throws(() => decideSchema.parse({ worker: job.worker, graph_id: job.graph_id,
      revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision,
      continuation: { title: "Unrequested", summary: "Start", from: ["origin"] } }), /unrecognized/i);
    assert.equal(store.get(first.project.id).steps[0].worker, "human");
    const prompt = promptFor(job, {}, snapshot);
    assert.doesNotMatch(prompt, /continuation/);
    assert.doesNotMatch(prompt, /续图/);
  } finally { store.close(); }
});

test("hints have selectable nodes and completed task labels retain their IDs", () => {
  const store = new Store(":memory:");
  try {
    const graph = create(store), id = graph.project.id;
    const hint = graph.hints[0];
    const step = store.manualStep(id, { from: ["origin"], description: "Observe", creator: "human", claim: true });
    store.mutate(id, "fixture.hint", false, g => { g.steps[0].hint_ids = [hint.id]; });
    store.manualConclude(id, step.id, "human", "Observation");
    const elements = graphElements(store.get(id), "main");
    assert.ok(elements.some(e => e.data.id === hint.id && e.data.type === "hint"));
    assert.ok(elements.some(e => e.data.status === "hint" && e.data.source === hint.id));
    assert.ok(elements.some(e => e.data.step_id === step.id && String(e.data.label).startsWith(step.id)));
    store.updateHint(id, hint.id, {}, true);
    assert.equal(graphElements(store.get(id), "main").some(e => e.data.id === hint.id), false);
  } finally { store.close(); }
});
