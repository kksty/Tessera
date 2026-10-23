import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";

function planned(store: Store) {
  const g = store.create(createProjectSchema.parse({ title: "改写", origin: "10.0.0.5", goal: "拿到 root", hints: [] }));
  const planner = store.claim(g.project.id, "planner", 0)!;
  commitPlan(store, g.project.id, decideSchema.parse({
    worker: planner.worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision,
    steps: [{ from: ["origin"], description: "扫描 10.0.0.5 的全端口" }],
  }));
  return { id: g.project.id, step: store.get(g.project.id).steps[0] };
}

test("a human rewrite changes what the next Decider reads and keeps the old text", () => {
  const store = new Store(":memory:");
  try {
    const { id, step } = planned(store);
    const before = store.get(id).revision;
    store.updateStep(id, step.id, { description: "只做 10.0.0.5 的 Web 入口，不要全端口扫描", expected_version: step.version ?? 1 });
    const after = store.get(id);
    const edited = after.steps.find((s) => s.id === step.id)!;
    assert.equal(edited.description, "只做 10.0.0.5 的 Web 入口，不要全端口扫描");
    assert.equal(edited.edits?.length, 1);
    assert.equal(edited.edits![0].from, "扫描 10.0.0.5 的全端口");
    assert.equal(edited.version, (step.version ?? 1) + 1);
    assert.ok(after.revision > before, "a rewrite re-opens the observation interval");
    assert.ok(store.events(id, 0).some((e) => e.kind === "step.updated"));
  } finally { store.close(); }
});

test("stale versions and running steps cannot be silently rewritten", () => {
  const store = new Store(":memory:");
  try {
    const { id, step } = planned(store);
    const executor = store.claim(id, "executor", 0)!;
    assert.equal(executor.step_id, step.id);
    assert.throws(() => store.updateStep(id, step.id, { description: "改掉正在跑的任务" }), /执行|running|worker/i);
    store.release(id, executor, "operator stopped it");
    assert.throws(() => store.updateStep(id, step.id, { description: "版本不符", expected_version: 99 }), /版本|version/i);
  } finally { store.close(); }
});

test("the root goal can be rewritten and the previous wording is retained", () => {
  const store = new Store(":memory:");
  try {
    const { id } = planned(store);
    store.editGoal(id, "goal", "拿到域控的管理员权限，而不是本机 root");
    const goal = store.get(id).goals.find((g) => g.id === "goal")!;
    assert.equal(goal.description, "拿到域控的管理员权限，而不是本机 root");
    assert.equal(goal.edits?.[0].from, "拿到 root");
    assert.ok(store.events(id, 0).some((e) => e.kind === "goal.edited"));
    assert.throws(() => store.editGoal(id, "goal", "   "), /不能为空/);
  } finally { store.close(); }
});
