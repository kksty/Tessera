import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, executeSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-decisions-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Decisions", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const submit = (body: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        graph_id: "main",
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...body,
      }),
    );
  };
  let round = 0;
  /** A new observation starts a fresh Decide lease even when unclaimed Steps exist. */
  const planner = () => {
    store.hint(id, `决策轮次 ${++round}`);
    const job = store.claim(id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    return job;
  };
  return {
    dir,
    store,
    id,
    submit,
    planner,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("one call plans new Steps and settles existing ones, then releases the lease", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    const response = f.submit({
      submission_id: "sub-plan-1",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Probe the login form" }],
    });
    assert.equal(response.plan.committed, true);
    assert.equal(response.plan.reused, false);
    assert.equal(response.plan.steps.length, 1);
    assert.equal(response.settle.ok, true);
    assert.deepEqual(response.settle.conflicts, []);
    const graph = f.store.get(f.id);
    const step = graph.steps.find((s) => s.id === response.plan.steps[0])!;
    assert.equal(step.version, 1);
    assert.equal(graph.project.reason, null, "a complete settle releases the Decide lease");
    assert.equal(graph.project.decision_round, 1, "a settled Decide advances the decision clock");
    // The idempotency row stores the exact response, not a second copy of the plan.
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans").get()!.n, 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_submissions").get()!.n, 1);
  } finally {
    f.close();
  }
});

test("a more:true part keeps the lease while a later part finishes the settlement", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const first = f.submit({
      submission_id: "sub-part-1",
      worker: job.worker,
      more: true,
      steps: [{ from: ["origin"], description: "Part one" }],
    });
    assert.equal(first.settle.ok, true);
    assert.equal(first.settle.more, true);
    assert.equal(first.settle.completed, false);
    const held = f.store.get(f.id);
    assert.equal(held.project.reason?.worker, job.worker, "a partial settlement keeps the Decide lease");
    assert.equal(held.project.decision_round, 0, "only the final part advances the decision clock");
    assert.equal(held.steps.length, 1);
    // The next part reuses the committed plan and finishes the settlement.
    const step = held.steps[0];
    const second = f.submit({
      submission_id: "sub-part-2",
      worker: job.worker,
      plan_id: first.plan_id,
      closes: [{ id: step.id, reason: "Settled in the second part", evidence_ids: [], expected_version: 1 }],
    });
    assert.equal(second.settle.ok, true);
    assert.notEqual(second.settle.more, true);
    assert.equal(second.plan.reused, true, "the plan is never replayed by a later part");
    const done = f.store.get(f.id);
    assert.equal(done.project.reason, null);
    assert.equal(done.project.decision_round, 1);
    assert.ok(done.steps.find((s) => s.id === step.id)!.concluded_at);
  } finally {
    f.close();
  }
});

test("a completion cannot be a partial settlement", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    assert.throws(
      () =>
        f.submit({
          submission_id: "sub-more-complete",
          worker: job.worker,
          more: true,
          complete: { from: ["origin"], description: "Done" },
        }),
      /completion ends the Decide run/i,
    );
    assert.equal(f.store.get(f.id).project.reason?.worker, job.worker);
  } finally {
    f.close();
  }
});

test("a settle conflict keeps the planned Steps, the lease and the version guard", () => {
  const f = fixture();
  try {
    let job = f.planner();
    const first = f.submit({
      submission_id: "sub-a",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Check A" }],
    });
    const stepId = first.plan.steps[0];
    // Execute it so the close target has a newer version than the one the model saw.
    const executor = f.store.claim(f.id, "executor", 0)!;
    assert.equal(executor.step_id, stepId);
    f.store.execute(
      f.id,
      stepId,
      executeSchema.parse({ worker: executor.worker, facts: ["Partial A"], summary: "done" }),
    );
    assert.equal(f.store.get(f.id).steps.find((s) => s.id === stepId)!.version, 2);

    job = f.planner();
    const conflict = f.submit({
      submission_id: "sub-b",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Check B" }],
      closes: [{ id: stepId, reason: "Stale version", evidence_ids: [], expected_version: 1 }],
    });
    assert.equal(conflict.settle.ok, false);
    assert.deepEqual(
      conflict.settle.conflicts.map((c) => c.kind),
      ["close"],
    );
    assert.match(conflict.settle.conflicts[0].reason, /version changed/);
    const graph = f.store.get(f.id);
    assert.equal(graph.steps.find((s) => s.id === stepId)!.concluded_at, null, "the failed settlement changed nothing");
    assert.equal(conflict.plan.steps.length, 1, "the plan is committed and never rolled back");
    assert.ok(
      graph.steps.some((s) => s.id === conflict.plan.steps[0]),
      "the planned Step exists despite the conflict",
    );
    assert.equal(graph.project.reason?.worker, job.worker, "the lease is kept so settle can be retried");
    assert.equal(graph.project.decision_round, 1, "only a complete settle advances the round");

    // Retry: only settlement fields and the plan_id; the plan is not replayed.
    const count = graph.steps.length;
    const retry = f.submit({
      submission_id: "sub-c",
      worker: job.worker,
      plan_id: conflict.plan_id,
      closes: [{ id: stepId, reason: "Evidence is enough", evidence_ids: [], expected_version: 2 }],
    });
    assert.equal(retry.settle.ok, true);
    assert.equal(retry.plan.reused, true);
    assert.deepEqual(retry.plan.steps, conflict.plan.steps);
    const after = f.store.get(f.id);
    assert.equal(after.steps.length, count, "retrying settle never duplicates the plan");
    assert.ok(after.steps.find((s) => s.id === stepId)!.concluded_at);
    assert.equal(after.project.reason, null);
    assert.equal(after.project.decision_round, 2);
  } finally {
    f.close();
  }
});

test("submission ids are idempotent and reject different content", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const graph = f.store.get(f.id);
    // A retried request resends the identical body (same snapshot), so the content hash matches.
    const body = submitDecisionsSchema.parse({
      submission_id: "sub-idem",
      worker: job.worker,
      graph_id: "main",
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
      steps: [{ from: ["origin"], description: "Once" }],
    });
    const first = f.store.submitDecisions(f.id, body);
    const again = f.store.submitDecisions(f.id, body);
    assert.deepEqual(again, first);
    assert.equal(f.store.get(f.id).steps.length, 1);
    assert.throws(
      () =>
        f.store.submitDecisions(f.id, {
          ...body,
          steps: [{ from: ["origin"], description: "Different content", priority: 0 }],
        }),
      /different content/,
    );
    assert.equal(f.store.get(f.id).steps.length, 1);
  } finally {
    f.close();
  }
});

test("closing, reopening, executing and reprioritising each increment the Step version", () => {
  const f = fixture();
  try {
    let job = f.planner();
    const plan = f.submit({
      submission_id: "sub-ver",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Versioned" }],
    });
    const stepId = plan.plan.steps[0];
    // Reprioritise: planned → version 2.
    job = f.planner();
    let response = f.submit({
      submission_id: "sub-ver-2",
      worker: job.worker,
      updates: [{ id: stepId, priority: 3, expected_version: 1 }],
    });
    assert.equal(response.settle.ok, true);
    assert.equal(f.store.get(f.id).steps.find((s) => s.id === stepId)!.version, 2);
    // Execute: version 3, still open.
    const executor = f.store.claim(f.id, "executor", 0)!;
    f.store.execute(
      f.id,
      stepId,
      executeSchema.parse({ worker: executor.worker, facts: ["Observed"], summary: "done" }),
    );
    let step = f.store.get(f.id).steps.find((s) => s.id === stepId)!;
    assert.equal(step.version, 3);
    assert.ok(step.executed_at);
    assert.equal(step.concluded_at, null);
    // Close: version 4.
    job = f.planner();
    response = f.submit({
      submission_id: "sub-ver-3",
      worker: job.worker,
      closes: [{ id: stepId, reason: "Answered", evidence_ids: [], expected_version: 3 }],
    });
    assert.equal(response.settle.ok, true);
    step = f.store.get(f.id).steps.find((s) => s.id === stepId)!;
    assert.equal(step.version, 4);
    assert.ok(step.concluded_at);
    // Reopen: version 5, executable again.
    job = f.planner();
    response = f.submit({
      submission_id: "sub-ver-4",
      worker: job.worker,
      reopens: [{ id: stepId, reason: "New contradiction", expected_version: 4 }],
    });
    assert.equal(response.settle.ok, true);
    step = f.store.get(f.id).steps.find((s) => s.id === stepId)!;
    assert.equal(step.version, 5);
    assert.equal(step.concluded_at, null);
    assert.equal(step.executed_at, null);
    assert.equal(f.store.claim(f.id, "executor-2", 0)!.step_id, stepId);
  } finally {
    f.close();
  }
});

test("complete requires a closed board and the current global water level", () => {
  const f = fixture();
  try {
    let job = f.planner();
    const plan = f.submit({
      submission_id: "sub-complete-a",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Still open" }],
    });
    const stepId = plan.plan.steps[0];
    job = f.planner();
    const blocked = f.submit({
      submission_id: "sub-complete-b",
      worker: job.worker,
      complete: { from: ["origin"], description: "Premature" },
    });
    assert.equal(blocked.settle.ok, false);
    assert.equal(blocked.settle.conflicts[0].kind, "complete");
    assert.equal(f.store.get(f.id).project.status, "active");
    // A conflicting settle keeps the lease, so the same Decide retries it directly.
    const closed = f.submit({
      submission_id: "sub-complete-c",
      worker: job.worker,
      closes: [{ id: stepId, reason: "Done", evidence_ids: [], expected_version: 1 }],
    });
    assert.equal(closed.settle.ok, true);
    job = f.planner();
    // Operator closure is required; a model note is advice only.
    for (const hint of f.store.get(f.id).hints.filter((h) => !h.withdrawn_at && !h.resolved))
      f.store.resolveHint(f.id, hint.id, { note: "仅用于推进决策轮次，无需单独立项" });
    const complete = f.submit({
      submission_id: "sub-complete-d",
      worker: job.worker,
      complete: { from: ["origin"], description: "Evidence supports the goal" },
    });
    assert.equal(complete.settle.ok, true);
    assert.equal(complete.settle.completed, true);
    const graph = f.store.get(f.id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.goals.find((g) => g.id === "goal")!.state, "satisfied");
  } finally {
    f.close();
  }
});

test("a settled decision is durable across restart and the lease can no longer be reused", () => {
  const f = fixture();
  try {
    const job = f.planner();
    const response = f.submit({
      submission_id: "sub-restart",
      worker: job.worker,
      steps: [{ from: ["origin"], description: "Durable" }],
    });
    assert.equal(response.settle.ok, true);
    assert.throws(
      () =>
        f.submit({
          submission_id: "sub-restart-late",
          worker: job.worker,
          steps: [{ from: ["origin"], description: "Late" }],
        }),
      /Decide lease required/,
    );
    f.store.close();
    const reopened = new Store(join(f.dir, "graph.db"));
    try {
      assert.equal(reopened.get(f.id).steps.length, 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM platform_submissions").get()!.n, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
