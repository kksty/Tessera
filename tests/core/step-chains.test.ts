import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { randomUUID } from "node:crypto";
import { commitPlan } from "../helpers/current-api.js";

function project() {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Chain", origin: "https://example.test", goal: "Assess" }))
    .project.id;
  const planner = store.claim(id, "planner", 0)!;
  return { store, id, planner };
}

function decisions(store: Store, id: string, worker: string, steps: unknown[]) {
  const graph = store.get(id);
  return decideSchema.parse({
    worker,
    revision: graph.revision,
    observation_revision: graph.observation_revision,
    planning_revision: graph.planning_revision,
    steps,
  });
}

/** A completed Execute wakes Decide first; settle that round before expecting the next link. */
function settleDecide(store: Store, id: string) {
  const job = store.claim(id, "planner-next", 0)!;
  assert.equal(job.kind, "decide");
  const graph = store.get(id);
  store.submitDecisions(
    id,
    submitDecisionsSchema.parse({
      worker: job.worker,
      submission_id: randomUUID(),
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
    }),
  );
}

test("a chain key links a later Step to the Step created earlier in the same plan", () => {
  const { store, id, planner } = project();
  try {
    commitPlan(
      store,
      id,
      decisions(store, id, planner.worker, [
        { key: "reach", from: ["origin"], description: "找到可注入参数" },
        { key: "exploit", depends_on: ["reach"], from: ["origin"], description: "利用注入读取文件" },
      ]),
    );
    const [reach, exploit] = store.get(id).steps;
    assert.deepEqual(exploit.depends_on, [reach.id]);
    assert.equal(reach.depends_on, undefined);

    const first = store.claim(id, "exec-1", 0)!;
    assert.equal(first.kind, "execute");
    assert.equal(first.step_id, reach.id);

    // The successor exists but is not claimable while its premise is still open.
    assert.equal(store.claim(id, "exec-2", 0), null);

    store.execute(id, first.step_id!, executeSchema.parse({ worker: first.worker, summary: "参数可达", facts: [] }));
    settleDecide(store, id);
    const second = store.claim(id, "exec-2", 0)!;
    assert.equal(second.kind, "execute");
    assert.equal(second.step_id, exploit.id);
  } finally {
    store.close();
  }
});

test("a chain rejects an unknown dependency and a duplicate key", () => {
  const { store, id, planner } = project();
  try {
    assert.throws(
      () =>
        commitPlan(
          store,
          id,
          decisions(store, id, planner.worker, [
            { key: "a", from: ["origin"], description: "第一步" },
            { depends_on: ["missing"], from: ["origin"], description: "第二步" },
          ]),
        ),
      /Unknown Step dependency/,
    );
    assert.throws(
      () =>
        commitPlan(
          store,
          id,
          decisions(store, id, planner.worker, [
            { key: "a", from: ["origin"], description: "第一步" },
            { key: "a", from: ["origin"], description: "重复 key" },
          ]),
        ),
      /Duplicate Step key/,
    );
  } finally {
    store.close();
  }
});

test("a discarded prerequisite keeps its successor blocked", () => {
  const { store, id, planner } = project();
  try {
    commitPlan(
      store,
      id,
      decisions(store, id, planner.worker, [
        { key: "reach", from: ["origin"], description: "找到入口" },
        { key: "exploit", depends_on: ["reach"], from: ["origin"], description: "利用入口" },
      ]),
    );
    const [reach, exploit] = store.get(id).steps;
    store.updateStep(id, reach.id, { discard: true, reason: "入口不存在" });
    const claimed = store.claim(id, "exec", 0);
    assert.notEqual(claimed?.step_id, exploit.id);
    const reloaded = store.get(id).steps.find((step) => step.id === exploit.id)!;
    assert.deepEqual(reloaded.depends_on, [reach.id]);

    // Deleting the premise would strand its successor; the preview must block it.
    const preview = store.previewDeletions(id, [{ id: reach.id, reason: "清理", cascade: "none" as const }]);
    assert.ok(
      preview.conflicts.some((conflict) => conflict.id === exploit.id),
      "deleting a prerequisite must name the dependent Step",
    );
  } finally {
    store.close();
  }
});
