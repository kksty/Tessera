import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { classificationReviewRequired, confirmedInformational } from "../../packages/protocol/src/finding-policy.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Reaudit", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "Original response",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      title: "Historical conclusion",
      description: "Passed under older rules",
      from: ["origin"],
      evidence_ids: [evidence.id],
      identity: { category: "exposure", host: "example.test", path: "/" },
    }),
  );
  const review = (body: Record<string, unknown>) => {
    const job = store.claim(id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
    return store.review(
      id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "pass",
        reason: "Original material checked",
        ...body,
      }),
    );
  };
  return { store, id, evidence, finding, review };
}

test("re-audit gives a completed project a Review-only window and restores its lifecycle", () => {
  const f = fixture();
  try {
    f.review({ kind: "informational" });
    f.store.mutate(f.id, "fixture.legacy", false, (graph) => {
      const current = graph.findings[0];
      delete current.kind;
      graph.project.status = "completed";
      graph.goals.find((goal) => goal.id === "goal")!.state = "satisfied";
      // A planning gap would normally wake Decide first; a re-audit must not.
      graph.project.decide_trigger_revision = (graph.decided_planning_revision ?? 0) + 1;
      graph.project.decide_trigger_at = "2000-01-01T00:00:00.000Z";
      graph.project.decide_pending_since = "2000-01-01T00:00:00.000Z";
    });
    const legacy = f.store.get(f.id);
    assert.equal(classificationReviewRequired(legacy.findings[0], legacy), true);
    assert.equal(pendingReviews(legacy).length, 1);

    const started = f.store.startReaudit(f.id);
    assert.deepEqual(started, { count: 1, resumed: true });
    let graph = f.store.get(f.id);
    assert.equal(graph.project.status, "active");
    assert.equal(graph.project.reaudit?.restore_status, "completed");
    assert.equal(typeof graph.project.reaudit?.planning_revision, "number");
    assert.equal(
      graph.goals.find((goal) => goal.id === "goal")!.state,
      "satisfied",
      "review-only work does not reopen the goal",
    );

    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review", "Review-only window must not hand out Decide or Execute");

    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "pass",
        kind: "informational",
        reason: "Current classification and evidence rules checked",
      }),
    );
    graph = f.store.get(f.id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.project.reaudit, undefined);
    assert.equal(graph.goals.find((goal) => goal.id === "goal")!.state, "satisfied");
    assert.equal(confirmedInformational(graph.findings[0], graph), true);
    assert.equal(pendingReviews(graph).length, 0);
    assert.equal(f.store.claim(f.id, "after", 0), null);
  } finally {
    f.store.close();
  }
});

test("a re-audit that raises new planning issues leaves the project active for Decide", () => {
  const f = fixture();
  try {
    f.review({ kind: "informational" });
    f.store.mutate(f.id, "fixture.legacy", false, (graph) => {
      delete graph.findings[0].kind;
      graph.project.status = "completed";
      graph.goals.find((goal) => goal.id === "goal")!.state = "satisfied";
    });
    f.store.startReaudit(f.id);
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "needs_evidence",
        reason: "The original pass did not establish authorization boundaries",
        planning_issues: ["Verify whether the endpoint is reachable without authentication"],
      }),
    );
    const graph = f.store.get(f.id);
    assert.equal(graph.project.reaudit, undefined);
    assert.equal(graph.project.status, "active", "new review issues must not be hidden behind completion");
    assert.equal(graph.goals.find((goal) => goal.id === "goal")!.state, "active");
  } finally {
    f.store.close();
  }
});

test("a manual lifecycle decision ends the review-only window", () => {
  const f = fixture();
  try {
    f.review({ kind: "informational" });
    f.store.mutate(f.id, "fixture.legacy", false, (graph) => {
      delete graph.findings[0].kind;
      graph.project.status = "completed";
    });
    f.store.startReaudit(f.id);
    f.store.status(f.id, "stopped");
    const graph = f.store.get(f.id);
    assert.equal(graph.project.status, "stopped");
    assert.equal(graph.project.reaudit, undefined);
  } finally {
    f.store.close();
  }
});
