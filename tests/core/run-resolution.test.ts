import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";

/** 一个已领取的 Execute：用来复现“运行需要人工检查，但任务被关闭”的分叉。 */
function fixture() {
  const store = new Store(":memory:");
  const graph = store.create(
    createProjectSchema.parse({
      title: "Run resolution",
      origin: "https://example.test",
      goal: "Assess",
    }),
  );
  const id = graph.project.id;
  const planner = store.claim(id, "planner", 0)!;
  const snapshot = store.get(id);
  commitPlan(
    store,
    id,
    decideSchema.parse({
      worker: planner.worker,
      revision: snapshot.revision,
      observation_revision: snapshot.observation_revision,
      planning_revision: snapshot.planning_revision,
      steps: [{ from: ["origin"], description: "Inspect one question" }],
    }),
  );
  const job = store.claim(id, "executor", 0)!;
  return { store, id, job };
}

const runOf = (store: Store, id: string, runId?: string) => store.runs(id).find((run) => run.id === runId)!;

test("closing a blocked Step settles its Run instead of leaving a permanent needs_attention", () => {
  const { store, id, job } = fixture();
  try {
    store.externalAction(id, job);
    store.release(id, job, "Connection lost after shell permission");
    const blocked = store.get(id).steps[0];
    assert.equal(runOf(store, id, job.run_id).status, "needs_attention");
    assert.equal(blocked.blocked_run_id, job.run_id);

    store.closeStep(id, job.step_id!, {
      worker: "human",
      reason: "已有证据足够，确认无需重跑",
      expected_version: blocked.version,
    });

    const step = store.get(id).steps[0],
      run = runOf(store, id, job.run_id);
    assert.ok(step.concluded_at);
    assert.equal(step.blocked_run_id, undefined, "关闭后不该再拦自动领取");
    assert.equal(run.status, "needs_attention", "失败记录保留为历史");
    assert.equal(run.resolved_by, "step.closed");
    assert.ok(run.resolved_at);
    assert.throws(() => store.retryRun(id, job.run_id!), /current blocked/);
  } finally {
    store.close();
  }
});

test("a Run cancelled by closing its live Step does not become needs_attention", () => {
  const { store, id, job } = fixture();
  try {
    store.externalAction(id, job);
    const step = store.get(id).steps[0];
    store.closeStep(id, job.step_id!, {
      worker: "human",
      reason: "人工确认结果已足够",
      expected_version: step.version,
    });

    const run = runOf(store, id, job.run_id);
    assert.equal(run.status, "cancelled");
    assert.equal(run.external_action_possible, true, "外部动作的不确定性仍留在运行记录里");
    assert.equal(run.resolved_at, undefined, "取消不是待人工处理");
    assert.equal(store.get(id).steps[0].blocked_run_id, undefined);
  } finally {
    store.close();
  }
});

test("Decide closing a blocked Step settles the Run it can no longer retry", () => {
  const { store, id, job } = fixture();
  try {
    store.externalAction(id, job);
    store.release(id, job, "执行中断：模型返回的 JSON 不合法");
    assert.equal(runOf(store, id, job.run_id).status, "needs_attention");

    const planner = store.claim(id, "decider", 0)!;
    assert.equal(planner.kind, "decide");
    const current = store.get(id),
      step = current.steps.find((value) => value.id === job.step_id)!;
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: planner.worker,
        revision: current.revision,
        observation_revision: current.observation_revision,
        planning_revision: current.planning_revision,
        closes: [{ id: step.id, reason: "原始结果已足够，无需重跑", expected_version: step.version }],
      }),
    );

    const after = store.get(id).steps.find((value) => value.id === step.id)!;
    const run = runOf(store, id, job.run_id);
    assert.ok(after.concluded_at);
    assert.equal(after.blocked_run_id, undefined);
    assert.equal(run.resolved_by, "step.closed");
  } finally {
    store.close();
  }
});

test("confirming a retry marks the Run as handled and releases the Step", () => {
  const { store, id, job } = fixture();
  try {
    store.externalAction(id, job);
    store.release(id, job, "Connection lost after shell permission");
    store.retryRun(id, job.run_id!);

    const run = runOf(store, id, job.run_id);
    assert.equal(run.resolved_by, "operator");
    assert.ok(run.resolved_at);
    assert.equal(store.get(id).steps[0].blocked_run_id, undefined);
    assert.throws(() => store.retryRun(id, job.run_id!), /current blocked/);
  } finally {
    store.close();
  }
});

test("a human-gated Execute does not burn the model-failure budget", () => {
  const { store, id, job } = fixture();
  try {
    store.mutate(id, "", false, (g) => {
      g.project.model_failures = 2;
    });
    store.externalAction(id, job);
    store.release(
      id,
      job,
      "Model provider failure: final JSON does not match the job protocol (execute): facts.0: Invalid input",
    );

    const blocked = store.get(id);
    assert.equal(blocked.steps[0].blocked_run_id, job.run_id);
    assert.equal(blocked.project.status, "active");
    assert.equal(
      blocked.project.model_failures,
      2,
      "the Step already stops auto-retry; it must not become the third project-wide strike",
    );
    assert.equal(blocked.project.model_retry_at, undefined, "no project-wide model backoff for a gated Run");

    // A Decide that is not gated still counts, and this one is the third.
    const planner = store.claim(id, "decider", 0)!;
    assert.equal(planner.kind, "decide");
    store.release(id, planner, "Model provider failure: 503: overloaded");
    const stopped = store.get(id);
    assert.equal(stopped.project.model_failures, 3);
    assert.equal(stopped.project.status, "stopped");
  } finally {
    store.close();
  }
});

test("an Execute that never reached the target still counts toward the model budget", () => {
  const { store, id, job } = fixture();
  try {
    store.release(id, job, "Model provider failure: 503: overloaded");
    const graph = store.get(id);
    assert.equal(graph.steps[0].blocked_run_id, undefined);
    assert.equal(graph.project.status, "active");
    assert.equal(graph.project.model_failures, 1);
  } finally {
    store.close();
  }
});
