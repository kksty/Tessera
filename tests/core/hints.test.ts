import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  findingSchema,
  reviewSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

const decision = (store: Store, id: string, worker: string, extra: Record<string, unknown>) => {
  const graph = store.get(id);
  return store.submitDecisions(
    id,
    submitDecisionsSchema.parse({
      worker,
      submission_id: `sub-${Math.random()}`,
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
      ...extra,
    }),
  );
};

test("Hint priority uses the task queue; editing cancels associated work and retains observations", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(
      createProjectSchema.parse({
        title: "Hint",
        origin: "origin",
        goal: "goal",
        hints: [{ content: "优先检查源文件", priority: 3 }],
      }),
    );
    const planner = store.claim(g.project.id, "planner", 0)!;
    commitPlan(
      store,
      g.project.id,
      decideSchema.parse({
        worker: planner.worker,
        revision: g.revision,
        observation_revision: g.observation_revision,
        planning_revision: g.planning_revision,
        steps: [
          { from: ["origin"], description: "其他方向", priority: 2 },
          { from: ["origin"], description: "读取源文件", priority: 0, hint_ids: ["h001"] },
        ],
      }),
    );
    const executor = store.claim(g.project.id, "executor", 0)!;
    assert.equal(executor.step_id, "s002");
    store.fact(g.project.id, executor.step_id!, {
      worker: executor.worker,
      description: "已经保存的观测",
      evidence_ids: [],
    });
    store.updateHint(g.project.id, "h001", { content: "改为检查另一份文件" });
    const changed = store.get(g.project.id);
    assert.equal(changed.steps[1].discarded, true);
    assert.equal(changed.steps[0].concluded_at, null);
    assert.equal(changed.facts.at(-1)?.description, "已经保存的观测");
    assert.throws(() => store.heartbeat(g.project.id, executor), /lease|concluded|worker/i);
    store.release(g.project.id, executor, "late cancelled task");
    assert.equal(store.get(g.project.id).project.last_error, undefined);
    store.updateHint(g.project.id, "h001", {}, true);
    assert.ok(store.get(g.project.id).hints[0].withdrawn_at);
  } finally {
    store.close();
  }
});

test("Hint withdrawal rejects stale associated planning and preserves audit history", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(
      createProjectSchema.parse({ title: "Hint", origin: "origin", goal: "goal", hints: [{ content: "方向" }] }),
    );
    const job = store.claim(g.project.id, "planner", 0)!;
    store.updateHint(g.project.id, "h001", {}, true);
    assert.throws(
      () =>
        commitPlan(
          store,
          g.project.id,
          decideSchema.parse({
            worker: job.worker,
            revision: g.revision,
            observation_revision: g.observation_revision,
            planning_revision: g.planning_revision,
            steps: [{ from: ["origin"], description: "过期方向", hint_ids: ["h001"] }],
          }),
        ),
      /Graph changed/,
    );
    assert.equal(store.get(g.project.id).steps.length, 0);
    assert.ok(store.events(g.project.id, 0).some((e) => e.kind === "hint.withdrawn"));
  } finally {
    store.close();
  }
});

test("reopening an operator-confirmed Hint invalidates pending completion and wakes Decide", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({
        title: "Hint reopen",
        origin: "https://example.test",
        goal: "Assess",
        hints: [{ content: "Check the login page" }],
      }),
    ).project.id;
    const evidence = store.addEvidence(id, {
      title: "proof",
      content: "observed",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        ...reportFields,
        title: "Claim",
        description: "Impact",
        from: ["origin"],
        evidence_ids: [evidence.id],
      }),
    );
    // Hold the review open so completion stays pending instead of finalizing at once.
    const review = store.claim(id, "reviewer", 60_000)!;
    store.resolveHint(id, "h001", { note: "人工确认" });
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
        complete: { from: ["origin"], description: "Done" },
      }),
    );
    const pending = store.get(id);
    assert.equal(pending.project.status, "active");
    assert.ok(pending.project.pending_completion, "completion waits for the running review");

    const planningBefore = pending.planning_revision;
    store.reopenHint(id, "h001", { by: "human" });
    const reopened = store.get(id);
    assert.equal(reopened.hints[0].resolved, undefined);
    assert.equal(reopened.project.pending_completion, undefined, "reopening must discard the completion proposal");
    assert.ok((reopened.planning_revision ?? 0) > (planningBefore ?? 0), "reopening is a planning change");
    const plannerAgain = store.claim(id, "planner-2", 0);
    assert.equal(plannerAgain?.kind, "decide", "Decide must be woken to plan the reopened directive");

    store.review(
      id,
      finding.id,
      reviewSchema.parse({
        kind: "vulnerability",
        worker: review.worker,
        finding_version: 1,
        verdict: "pass",
        reason: "proof supports the claim",
        evidence_ids: [evidence.id],
        cvss: cvss.high,
      }),
    );
    assert.equal(store.get(id).project.status, "active", "an open Hint still blocks completion");

    const blocked = decision(store, id, plannerAgain!.worker, {
      complete: { from: ["origin"], description: "Done again" },
    });
    assert.equal(blocked.settle.ok, false);
    assert.match(blocked.settle.conflicts[0].reason, /h001/);
  } finally {
    store.close();
  }
});

test("editing a confirmed Hint on a completed project reopens the search", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({
        title: "Hint after completion",
        origin: "https://example.test",
        goal: "Assess",
        hints: [{ content: "Check the login page" }],
      }),
    ).project.id;
    store.resolveHint(id, "h001", { note: "人工确认" });
    const planner = store.claim(id, "planner", 0)!;
    const graph = store.get(id);
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: planner.worker,
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        complete: { from: ["origin"], description: "Done" },
      }),
    );
    assert.equal(store.get(id).project.status, "completed");

    store.updateHint(id, "h001", { content: "Actually inspect the password reset flow" });
    const reopened = store.get(id);
    assert.equal(reopened.project.status, "active", "a rewritten directive must reopen the search");
    assert.equal(reopened.hints[0].resolved, undefined);
    const next = store.claim(id, "planner-2", 0);
    assert.equal(next?.kind, "decide");
  } finally {
    store.close();
  }
});

test("a model note closes a Hint (resolved_by decide); an unexplained Hint still blocks", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({
        title: "Hint closure",
        origin: "https://example.test",
        goal: "goal",
        hints: [{ content: "Check the login page" }],
      }),
    ).project.id;
    const planner = store.claim(id, "planner", 0)!;
    const noted = decision(store, id, planner.worker, {
      hint_notes: [{ id: "h001", note: "低优先级，本轮先不单独立项" }],
    });
    assert.equal(noted.settle.ok, true);
    let graph = store.get(id);
    assert.equal(graph.hints[0].resolved_by, "decide", "a non-empty note is a model closure");
    assert.equal(graph.hints[0].resolved?.note, "低优先级，本轮先不单独立项");
    assert.equal(graph.hints[0].notes?.at(-1)?.note, "低优先级，本轮先不单独立项");

    // A new directive wakes Decide again; without a note it still blocks complete.
    store.hint(id, "Follow up on the login page");
    const planner2 = store.claim(id, "planner-2", 0)!;
    assert.equal(planner2.kind, "decide");
    const blocked = decision(store, id, planner2.worker, { complete: { from: ["origin"], description: "Done" } });
    assert.equal(blocked.settle.ok, false);
    assert.match(blocked.settle.conflicts[0].reason, /h002/);

    // The Decider closes the remaining Hint by explaining it, then completes.
    const closed = decision(store, id, planner2.worker, {
      hint_notes: [{ id: "h002", note: "已在本轮结论中落实登录页检查" }],
      complete: { from: ["origin"], description: "Done" },
    });
    assert.equal(closed.settle.ok, true);
    assert.equal(store.get(id).project.status, "completed");
    assert.equal(store.get(id).hints[1].resolved_by, "decide");
  } finally {
    store.close();
  }
});

test("an operator can reopen a Hint the model closed", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({
        title: "Reopen model closure",
        origin: "https://example.test",
        goal: "goal",
        hints: [{ content: "Check the login page" }],
      }),
    ).project.id;
    const planner = store.claim(id, "planner", 0)!;
    decision(store, id, planner.worker, { hint_notes: [{ id: "h001", note: "已落实，无独立价值" }] });
    assert.equal(store.get(id).hints[0].resolved_by, "decide");
    store.reopenHint(id, "h001", { note: "仍需跟踪" });
    assert.equal(store.get(id).hints[0].resolved, undefined);
    assert.equal(store.get(id).hints[0].reopened_at !== undefined, true);
  } finally {
    store.close();
  }
});
