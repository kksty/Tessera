import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { effectiveStepPriority } from "../../packages/core/src/hint-coverage.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "FGS logic", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const submit = (worker: string, submission_id: string, input: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker,
        submission_id,
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...input,
      }),
    );
  };
  const plan = (input: Record<string, unknown> = {}) => {
    const job = store.claim(id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    return submit(job.worker, "initial-plan", { steps: [{ from: ["origin"], description: "Inspect", ...input }] }).plan
      .steps[0];
  };
  return { store, id, submit, plan };
}

test("future observation watermarks cannot suppress later Decide work or persist a plan", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const before = f.store.get(f.id);
    assert.throws(
      () =>
        f.submit(job.worker, "future", {
          observation_revision: before.revision + 1000,
          steps: [{ from: ["origin"], description: "Impossible snapshot" }],
        }),
      /Future snapshot/,
    );
    assert.deepEqual(f.store.get(f.id), before);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans").get()!.n, 0);
  } finally {
    f.store.close();
  }
});

for (const legacy of [false, true])
  test(`unrelated parallel facts do not invalidate unchanged Hint dependencies (${legacy ? "legacy" : "plan/settle"})`, () => {
    const f = fixture();
    try {
      f.store.hint(f.id, "Inspect A");
      const planner = f.store.claim(f.id, "planner", 0)!;
      const snapshot = f.store.get(f.id);
      f.store.discover(f.id, [{ hostname: "unrelated.example.test", source: "Parallel result", evidence_ids: [] }]);
      const body = {
        worker: planner.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: snapshot.planning_revision,
        steps: [{ from: ["origin"], description: "Inspect A", hint_ids: ["h001"] }],
      };
      if (legacy) commitPlan(f.store, f.id, decideSchema.parse(body));
      else
        assert.equal(
          f.store.submitDecisions(f.id, submitDecisionsSchema.parse({ submission_id: "unrelated", ...body })).settle.ok,
          true,
        );
      assert.deepEqual(f.store.get(f.id).steps[0].hint_ids, ["h001"]);
      assert.ok(
        f.store.get(f.id).decided_revision < f.store.get(f.id).observation_revision,
        "new parallel results still need a later Decide",
      );
    } finally {
      f.store.close();
    }
  });

test("decision batches refuse duplicate and conflicting operations on one Step through both contracts", () => {
  const common = { worker: "planner", revision: 1, observation_revision: 1 };
  const duplicate = { id: "s001", priority: 2, expected_version: 1 };
  for (const operations of [
    { updates: [duplicate, duplicate] },
    {
      updates: [{ id: "s001", discard: true, expected_version: 1 }],
      closes: [{ id: "s001", reason: "Also close", expected_version: 1 }],
    },
    {
      updates: [{ id: "s001", discard: true, expected_version: 1 }],
      reopens: [{ id: "s001", reason: "Also reopen", expected_version: 1 }],
    },
  ]) {
    for (const schema of [decideSchema, submitDecisionsSchema]) {
      const parsed = schema.safeParse({
        ...common,
        ...(schema === submitDecisionsSchema ? { submission_id: "batch" } : {}),
        ...operations,
      });
      assert.equal(parsed.success, false);
      if (!parsed.success) assert.match(parsed.error.message, /only one update, close or reopen/);
    }
  }
});

test("root Goal is never accepted as a source Fact during completion settlement", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const result = f.submit(job.worker, "goal-is-not-fact", {
      complete: { from: ["goal"], description: "Circular justification" },
    });
    assert.equal(result.settle.ok, false);
    assert.match(result.settle.conflicts[0].reason, /Invalid source fact goal/);
    assert.equal(f.store.get(f.id).project.reason?.worker, job.worker);
    assert.equal(
      f.submit(job.worker, "actual-proof", {
        plan_id: result.plan_id,
        complete: { from: ["origin"], description: "Actual source" },
      }).settle.ok,
      true,
    );
  } finally {
    f.store.close();
  }
});

test("complete.from naming a Finding explains the id space instead of only rejecting the Fact", () => {
  const f = fixture();
  try {
    const finding = f.store.submitFinding(
      f.id,
      findingSchema.parse({ title: "Candidate", description: "Observed candidate" }),
    );
    const job = f.store.claim(f.id, "planner", 0)!;
    const result = f.submit(job.worker, "finding-is-not-fact", {
      complete: { from: [finding.id], description: "Use this finding" },
    });
    assert.equal(result.settle.ok, false);
    const reason = result.settle.conflicts.find((conflict) => conflict.kind === "complete")!.reason;
    assert.match(reason, /Invalid source fact v001/);
    assert.match(reason, /Finding 编号 v###/);
    assert.match(reason, /finding_updates/);
  } finally {
    f.store.close();
  }
});

test("a human priority or discard edit respects the supplied Step version", () => {
  const f = fixture();
  try {
    const sid = f.plan();
    f.store.updateStep(f.id, sid, { priority: 3, expected_version: 1 });
    const before = f.store.get(f.id);
    for (const change of [{ priority: 8 }, { discard: true }]) {
      assert.throws(() => f.store.updateStep(f.id, sid, { ...change, expected_version: 1 }), /version changed/);
      assert.deepEqual(f.store.get(f.id), before);
    }
  } finally {
    f.store.close();
  }
});

test("execution results stay attached to the original question and appear in the decision projection", () => {
  const f = fixture();
  try {
    const sid = f.plan();
    const execution = f.store.claim(f.id, "executor", 0)!;
    f.store.execute(
      f.id,
      sid,
      executeSchema.parse({
        worker: execution.worker,
        facts: ["Observed endpoint"],
        summary: "Cookie required; the unauthenticated request was refused",
      }),
    );
    const graph = f.store.get(f.id);
    const entry = memoryEntry(graph, { ...execution, kind: "decide" }) as { steps: string[] };
    assert.match(entry.steps[0], /Cookie required/);
    assert.match(entry.steps[0], /→ f001/);
    assert.throws(() => f.store.updateStep(f.id, sid, { description: "A different question" }), /任务已执行/);
    assert.equal(f.store.get(f.id).steps[0].description, "Inspect");
    f.store.closeStep(f.id, sid, { worker: "human", reason: "Answer accepted" });
    f.store.reopenStep(f.id, sid, { worker: "human", reason: "Verify with the newly authorized cookie" });
    f.store.updateStep(f.id, sid, { description: "Inspect with the cookie" });
    const rerun = memoryEntry(f.store.get(f.id), execution) as unknown as { focus: { reopen_reason: string } };
    assert.equal(rerun.focus.reopen_reason, "Verify with the newly authorized cookie");
  } finally {
    f.store.close();
  }
});

test("manual reopen checks source existence and cannot revive a broken graph edge", () => {
  const f = fixture();
  try {
    const sid = f.plan();
    f.store.closeStep(f.id, sid, { worker: "human", reason: "Closed" });
    f.store.mutate(f.id, "", false, (graph) => {
      graph.steps[0].from = ["missing-fact"];
    });
    assert.throws(() => f.store.reopenStep(f.id, sid, { worker: "human", reason: "Retry" }), /Invalid source fact/);
    assert.ok(f.store.get(f.id).steps[0].concluded_at);
  } finally {
    f.store.close();
  }
});

test("identical plans preserve versions, but different subgoals remain different Steps", () => {
  const f = fixture();
  try {
    f.store.hint(f.id, "Inspect A");
    const sid = f.plan({ hint_ids: ["h001"] });
    const execution = f.store.claim(f.id, "executor", 0)!;
    f.store.hint(f.id, "Record a subgoal");
    const planner = f.store.claim(f.id, "planner-2", 0)!;
    const result = f.submit(planner.worker, "dedup", {
      steps: [{ from: ["origin"], description: "Inspect", hint_ids: ["h001"] }],
      updates: [{ id: sid, priority: 4, expected_version: 1 }],
      goals: [{ description: "A separate purpose" }],
    });
    assert.equal(result.settle.ok, true, "a no-op Hint association must not invalidate the model's version");
    assert.equal(result.plan.steps[0], sid);
    f.store.hint(f.id, "Use the new subgoal");
    const next = f.store.claim(f.id, "planner-3", 0)!;
    const different = f.submit(next.worker, "different-goal", {
      steps: [{ from: ["origin"], description: "Inspect", goal_id: "g001" }],
    });
    assert.notEqual(different.plan.steps[0], sid);
    assert.equal(f.store.get(f.id).steps.find((s) => s.id === sid)!.worker, execution.worker);
  } finally {
    f.store.close();
  }
});

for (const executed of [false, true])
  test(`a new directive cannot be satisfied by attaching it to ${executed ? "past" : "running"} work`, () => {
    const f = fixture();
    try {
      const sid = f.plan();
      const execution = f.store.claim(f.id, "executor", 0)!;
      if (executed)
        f.store.execute(f.id, sid, executeSchema.parse({ worker: execution.worker, summary: "Original work" }));
      f.store.hint(f.id, "Inspect using a specific additional method");
      const planner = f.store.claim(f.id, "planner-2", 0)!;
      const result = f.submit(planner.worker, "new-directive", {
        steps: [{ from: ["origin"], description: "Inspect", hint_ids: ["h001"] }],
      });
      assert.notEqual(result.plan.steps[0], sid);
      assert.deepEqual(f.store.get(f.id).steps[0].hint_ids ?? [], []);
      assert.deepEqual(f.store.get(f.id).steps[1].hint_ids, ["h001"]);
    } finally {
      f.store.close();
    }
  });

test("queue and execution projection share Hint priority, without absent Hints raising negative values to zero", () => {
  const f = fixture();
  try {
    f.store.hint(f.id, "Low priority", "human", -5);
    const sid = f.plan({ priority: -10, hint_ids: ["h001"] });
    let graph = f.store.get(f.id);
    const execution = f.store.claim(f.id, "executor", 0)!;
    assert.equal(effectiveStepPriority(graph, graph.steps[0]), -5);
    assert.equal((memoryEntry(graph, execution) as unknown as { focus: { priority: number } }).focus.priority, -5);
    graph.hints[0].version = 2;
    assert.equal(effectiveStepPriority(graph, graph.steps[0]), -10);
    graph.hints[0].version = 1;
    graph.hints[0].withdrawn_at = new Date().toISOString();
    assert.equal(effectiveStepPriority(graph, graph.steps[0]), -10);
    assert.equal(sid, execution.step_id);
  } finally {
    f.store.close();
  }
});

test("repeating approval of an already approved asset leaves completed projects completed", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    f.submit(job.worker, "complete", { complete: { from: ["origin"], description: "Finished" } });
    const before = f.store.get(f.id);
    f.store.approve(f.id, ["a001"]);
    assert.deepEqual(f.store.get(f.id), before);
  } finally {
    f.store.close();
  }
});
