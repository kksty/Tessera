import { commitPlan } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";

function project(store: Store) {
  return store.create(
    createProjectSchema.parse({
      title: "Adversarial fixes",
      origin: "https://example.test",
      goal: "Assess",
    }),
  ).project.id;
}

function plan(store: Store, id: string, description = "Inspect the target") {
  const job = store.claim(id, "planner", 0)!;
  assert.equal(job.kind, "decide");
  const graph = store.get(id);
  commitPlan(
    store,
    id,
    decideSchema.parse({
      worker: job.worker,
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
      steps: [{ from: ["origin"], description }],
    }),
  );
  return store.get(id).steps.find((step) => step.description === description)!;
}

function submit(store: Store, id: string, body: Record<string, unknown>) {
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
}

test("completion cannot ignore a running Step, but closing it in the same settlement works", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const step = plan(store, id);
    const executor = store.claim(id, "executor", 0)!;
    assert.equal(executor.step_id, step.id);
    store.hint(id, "Reconsider completion while the Step runs");
    const decision = store.claim(id, "planner-2", 0)!;
    assert.equal(decision.kind, "decide");
    const ignored = submit(store, id, {
      submission_id: "running-a",
      worker: decision.worker,
      complete: { from: ["origin"], description: "Done" },
    });
    assert.equal(ignored.settle.ok, false);
    assert.equal(ignored.settle.conflicts[0].kind, "complete");
    assert.match(ignored.settle.conflicts[0].reason, /remaining steps/);
    assert.equal(store.get(id).project.status, "active");
    // Same Decide lease: close the running Step and complete in one settlement.
    // The Hint issued above must be confirmed by a human before completion.
    const hint = store.get(id).hints[0];
    store.resolveHint(id, hint.id, { note: "已纳入关闭理由，无需单独立项" });
    const settled = submit(store, id, {
      submission_id: "running-b",
      worker: decision.worker,
      closes: [{ id: step.id, reason: "Enough evidence", evidence_ids: [], expected_version: step.version }],
      complete: { from: ["origin"], description: "Done" },
    });
    assert.equal(settled.settle.ok, true);
    assert.equal(settled.settle.completed, true);
    assert.equal(store.get(id).project.status, "completed");
  } finally {
    store.close();
  }
});

test("revoking an asset cancels an in-flight review and prevents a new one", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "Verify",
      creator: "human",
      claim: true,
      asset_id: "a001",
    });
    const evidence = store.addEvidence(id, {
      title: "proof",
      content: "observed",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const finding = store.submitStepFinding(
      id,
      step.id,
      "human",
      findingSchema.parse({
        title: "Issue",
        description: "Observed",
        evidence_ids: [evidence.id],
        asset_id: "a001",
      }),
    );
    store.manualConclude(id, step.id, "human", "Finished");
    const review = store.claim(id, "reviewer", deferDecideMs)!;
    assert.equal(review.kind, "review");
    assert.equal(store.get(id).findings.find((f) => f.id === finding.id)!.review_worker, "reviewer");
    store.revokeAssets(id, ["a001"]);
    const graph = store.get(id);
    const after = graph.findings.find((f) => f.id === finding.id)!;
    assert.equal(after.review_worker, null, "the review lease is cancelled");
    assert.equal(store.runs(id).find((run) => run.id === review.run_id)!.status, "cancelled");
    // The finding is still review-pending, but no new review may be claimed.
    const next = store.claim(id, "reviewer-2", deferDecideMs);
    assert.notEqual(next?.kind, "review");
    // Re-approval makes review possible again.
    store.approve(id, ["a001"]);
    assert.equal(store.claim(id, "reviewer-3", deferDecideMs)?.kind, "review");
  } finally {
    store.close();
  }
});

test("a reopen reason is stored on the Step through both reopen paths", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const step = plan(store, id);
    store.closeStep(id, step.id, { worker: "human", reason: "First close" });
    store.reopenStep(id, step.id, { worker: "human", reason: "Contradiction found" });
    let reopened = store.get(id).steps.find((s) => s.id === step.id)!;
    assert.equal(reopened.reopen_reason, "Contradiction found");
    store.closeStep(id, step.id, { worker: "human", reason: "Second close" });
    store.hint(id, "Reconsider the closed Step");
    const decision = store.claim(id, "planner-2", 0)!;
    const current = store.get(id).steps.find((s) => s.id === step.id)!;
    const settled = submit(store, id, {
      submission_id: "reopen-reason",
      worker: decision.worker,
      reopens: [{ id: step.id, reason: "New evidence contradicts the close", expected_version: current.version }],
    });
    assert.equal(settled.settle.ok, true);
    reopened = store.get(id).steps.find((s) => s.id === step.id)!;
    assert.equal(reopened.reopen_reason, "New evidence contradicts the close");
    assert.ok(
      store.events(id).some((event) => JSON.stringify(event.data).includes("New evidence contradicts the close")),
      "the reopen reason is auditable in the event stream",
    );
  } finally {
    store.close();
  }
});

test("the submission fingerprint covers asset cooling", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const decision = store.claim(id, "planner", 0)!;
    const first = submit(store, id, {
      submission_id: "asset-hash",
      worker: decision.worker,
      assets: [{ id: "a001", state: "cooled", reason: "irrelevant now" }],
    });
    assert.equal(first.settle.ok, true);
    assert.equal(store.get(id).assets[0].cooldown_override, "cooled");
    assert.throws(
      () =>
        store.submitDecisions(
          id,
          submitDecisionsSchema.parse({
            graph_id: "main",
            revision: store.get(id).revision,
            observation_revision: store.get(id).observation_revision,
            submission_id: "asset-hash",
            worker: decision.worker,
            assets: [{ id: "a001", state: "auto" }],
          }),
        ),
      /different content/,
    );
    assert.equal(store.get(id).assets[0].cooldown_override, "cooled");
  } finally {
    store.close();
  }
});

test("re-selecting active does not cancel a live Run", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const step = plan(store, id);
    const executor = store.claim(id, "executor", 0)!;
    store.status(id, "active");
    const graph = store.get(id);
    assert.equal(graph.steps.find((s) => s.id === step.id)!.worker, "executor");
    assert.equal(store.runs(id).find((run) => run.id === executor.run_id)!.status, "running");
    store.status(id, "stopped");
    assert.equal(store.runs(id).find((run) => run.id === executor.run_id)!.status, "cancelled");
  } finally {
    store.close();
  }
});

test("asset discovery is an observation and cannot run on a paused project", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const before = store.get(id).observation_revision;
    store.discover(id, [{ hostname: "new.example.test", source: "discovery", evidence_ids: [] }]);
    assert.ok(store.get(id).observation_revision > before);
    store.status(id, "stopped");
    assert.throws(
      () => store.discover(id, [{ hostname: "late.example.test", source: "discovery", evidence_ids: [] }]),
      /Project is stopped/,
    );
  } finally {
    store.close();
  }
});

test("old project JSON without the current format marker is rejected and hidden", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const legacy = store.get(id);
    delete (legacy as unknown as { format_version?: number }).format_version;
    store.db.prepare("UPDATE platform_projects SET data=? WHERE id=?").run(JSON.stringify(legacy), id);
    assert.throws(() => store.get(id), /incompatible/);
    assert.equal(
      store.list().some((entry) => entry.id === id),
      false,
    );
    assert.equal(store.overview().totals.projects, 0);
    assert.equal(store.allFindings().length, 0);
  } finally {
    store.close();
  }
});

test("project removal clears replay receipts, plans and peek seeds", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const decision = store.claim(id, "planner", 0)!;
    submit(store, id, {
      submission_id: "cleanup",
      worker: decision.worker,
      steps: [{ from: ["origin"], description: "Keep history" }],
    });
    store.peekCold(id, { limit: 5 });
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM platform_submissions WHERE project_id=?").get(id)!.n);
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans WHERE project_id=?").get(id)!.n);
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM platform_pools WHERE project_id=?").get(id)!.n);
    store.remove(id);
    for (const table of ["platform_submissions", "platform_plans", "platform_pools"])
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(id)!.n, 0, table);
  } finally {
    store.close();
  }
});
