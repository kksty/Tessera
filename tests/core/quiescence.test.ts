import { commitPlan } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-quiescence-"));
  const file = join(dir, "graph.db"),
    store = new Store(file);
  const graph = store.create(
    createProjectSchema.parse({ title: "Quiescence", origin: "https://example.test", goal: "Assess" }),
  );
  const evidence = store.addEvidence(graph.project.id, {
    title: "Original proof",
    content: "Observed result",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    graph.project.id,
    findingSchema.parse({
      ...reportFields,
      title: "Claim",
      description: "Impact",
      from: ["origin"],
      evidence_ids: [evidence.id],
    }),
  );
  const review = store.claim(graph.project.id, "reviewer", deferDecideMs)!;
  return {
    store,
    id: graph.project.id,
    finding,
    evidence,
    review,
    file,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function decide(store: Store, id: string, payload: Record<string, unknown>) {
  const job = store.claim(id, "planner", 0)!;
  assert.equal(job.kind, "decide");
  const snapshot = store.get(id);
  return commitPlan(
    store,
    id,
    decideSchema.parse({
      ...payload,
      worker: job.worker,
      revision: snapshot.revision,
      observation_revision: snapshot.observation_revision,
      planning_revision: snapshot.planning_revision,
    }),
  );
}
const complete = { complete: { from: ["origin"], description: "No further exploration needed" } };

test("last ordinary pass completes delivery without waking another Decide or acknowledging unread observations", () => {
  const f = fixture();
  try {
    decide(f.store, f.id, complete);
    const pending = f.store.get(f.id);
    assert.equal(pending.project.status, "active");
    assert.ok(pending.project.pending_completion);
    assert.equal(pending.project.reason, null);
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        kind: "vulnerability",
        worker: f.review.worker,
        finding_version: 1,
        verdict: "pass",
        reason: "Original proof supports impact",
        evidence_ids: [f.evidence.id],
        cvss: cvss.high,
      }),
    );
    const final = f.store.get(f.id);
    assert.equal(final.project.status, "completed");
    assert.equal(final.project.pending_completion, undefined);
    assert.ok(final.observation_revision > pending.observation_revision);
    assert.equal(final.decided_revision, pending.decided_revision);
    assert.equal(final.planning_revision, pending.planning_revision);
    assert.equal(f.store.claim(f.id, "unneeded-planner", 0), null);
    assert.equal(f.store.get(f.id).project.status, "completed");
    assert.equal(f.store.get(f.id).steps.filter((s) => s.to === "goal").length, 1);
    assert.equal(
      f.store.events(f.id).at(-1)?.data.changes && (f.store.events(f.id).at(-1)!.data.changes as any).project.status,
      "completed",
    );
  } finally {
    f.close();
  }
});

for (const verdict of ["needs_evidence", "rejected"] as const)
  test(`${verdict} invalidates completion and is consumed once by Decide`, () => {
    const f = fixture();
    try {
      decide(f.store, f.id, complete);
      f.store.review(
        f.id,
        f.finding.id,
        reviewSchema.parse({
          worker: f.review.worker,
          finding_version: 1,
          verdict,
          reason: "Core fact needs correction",
          verification: "Check counterexample",
        }),
      );
      const negative = f.store.get(f.id);
      assert.equal(negative.project.pending_completion, undefined);
      assert.ok(negative.observation_revision > negative.decided_revision);
      assert.equal(negative.steps.length, 0, "Review never creates verification Steps");
      decide(f.store, f.id, {});
      assert.equal(f.store.claim(f.id, "idle", 0), null, "Same version is not re-reviewed or re-decided");
      f.store.hint(f.id, "Accept the review and end exploration");
      f.store.resolveHint(f.id, "h001", { note: "已采纳：按此提示结束探索" });
      decide(f.store, f.id, complete);
      assert.equal(f.store.get(f.id).project.status, "completed");
    } finally {
      f.close();
    }
  });

test("pending unclaimed review and backoff survive restart without premature completion", () => {
  const f = fixture();
  try {
    f.store.release(f.id, f.review, "Transient reviewer failure");
    decide(f.store, f.id, complete);
    assert.equal(f.store.claim(f.id, "idle", 0), null);
    const restarted = new Store(f.file);
    try {
      assert.equal(restarted.get(f.id).project.status, "active");
      assert.ok(restarted.get(f.id).project.pending_completion);
      restarted.mutate(f.id, "fixture.retry", false, (g) => {
        g.findings[0].retry_at = undefined;
      });
      const job = restarted.claim(f.id, "recovered-reviewer", deferDecideMs)!;
      assert.equal(job.kind, "review");
      restarted.review(
        f.id,
        f.finding.id,
        reviewSchema.parse({
          kind: "vulnerability",
          worker: job.worker,
          finding_version: 1,
          verdict: "pass",
          reason: "Verified",
          evidence_ids: [f.evidence.id],
          cvss: cvss.high,
        }),
      );
      assert.equal(restarted.get(f.id).project.status, "completed");
    } finally {
      restarted.close();
    }
  } finally {
    f.close();
  }
});

test("new Finding version or Hint cancels a previous completion intent", () => {
  const f = fixture();
  try {
    decide(f.store, f.id, complete);
    f.store.submitFinding(
      f.id,
      findingSchema.parse({
        id: f.finding.id,
        title: "Claim",
        description: "Revised claim",
        from: ["origin"],
        evidence_ids: [f.evidence.id],
      }),
    );
    assert.equal(f.store.get(f.id).project.pending_completion, undefined);
    const reviewer = f.store.claim(f.id, "reviewer-v2", deferDecideMs)!;
    assert.equal(reviewer.finding_version, 2);
    decide(f.store, f.id, complete);
    f.store.hint(f.id, "A new independent direction");
    assert.equal(f.store.get(f.id).project.pending_completion, undefined);
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        kind: "vulnerability",
        worker: reviewer.worker,
        finding_version: 2,
        verdict: "pass",
        reason: "Verified",
        evidence_ids: [f.evidence.id],
        cvss: cvss.high,
      }),
    );
    assert.equal(f.store.get(f.id).project.status, "active");
    assert.equal(f.store.claim(f.id, "fresh-planner", 0)?.kind, "decide");
  } finally {
    f.close();
  }
});

test("legacy completion also refuses a running Execute until its work is closed", () => {
  const f = fixture();
  try {
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        kind: "vulnerability",
        worker: f.review.worker,
        finding_version: 1,
        verdict: "pass",
        reason: "Verified",
        evidence_ids: [f.evidence.id],
        cvss: cvss.high,
      }),
    );
    const step = f.store.manualStep(f.id, {
      from: ["origin"],
      description: "Running work",
      creator: "executor",
      claim: true,
    });
    assert.throws(() => decide(f.store, f.id, complete), /remaining steps/);
    assert.equal(f.store.get(f.id).project.pending_completion, undefined);
    f.store.manualConclude(f.id, step.id, "executor", "Late observation");
    assert.equal(f.store.get(f.id).project.status, "active");
    assert.equal(f.store.get(f.id).project.pending_completion, undefined);
    const snapshot = f.store.get(f.id);
    commitPlan(
      f.store,
      f.id,
      decideSchema.parse({
        worker: "planner",
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: snapshot.planning_revision,
        ...complete,
      }),
    );
    assert.equal(f.store.get(f.id).project.status, "completed");
  } finally {
    f.close();
  }
});

test("pass cannot dispute facts or accept a narrative without original Evidence", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.review(
          f.id,
          f.finding.id,
          reviewSchema.parse({
            kind: "vulnerability",
            worker: f.review.worker,
            finding_version: 1,
            verdict: "pass",
            reason: "Inconsistent",
            disputed_fact_ids: ["origin"],
          }),
        ),
      /cannot dispute/,
    );
    f.store.release(f.id, f.review);
    f.store.submitFinding(
      f.id,
      findingSchema.parse({
        id: f.finding.id,
        title: "Claim",
        description: "Unproven",
        from: ["origin"],
        evidence_ids: [],
        evidence: "Another agent says so",
      }),
    );
    const job = f.store.claim(f.id, "reviewer-v2", deferDecideMs)!;
    assert.throws(
      () =>
        f.store.review(
          f.id,
          f.finding.id,
          reviewSchema.parse({
            kind: "vulnerability",
            worker: job.worker,
            finding_version: 2,
            verdict: "pass",
            reason: "Narrative only",
          }),
        ),
      /referenced evidence/,
    );
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        kind: "vulnerability",
        worker: job.worker,
        finding_version: 2,
        verdict: "pass",
        reason: "Read original proof",
        evidence_ids: [f.evidence.id],
        cvss: cvss.high,
      }),
    );
    assert.deepEqual(f.store.get(f.id).findings[0].evidence_ids, [f.evidence.id]);
  } finally {
    f.close();
  }
});

test("provider quota failures stop retries while stale workers cannot stop a project", () => {
  const f = fixture();
  try {
    const error = "Model provider failure: 402: insufficient_balance_error";
    f.store.release(f.id, { ...f.review, worker: "stale" }, error);
    assert.equal(f.store.get(f.id).project.status, "active");
    f.store.release(f.id, f.review, error);
    assert.equal(f.store.get(f.id).project.status, "stopped");
    assert.equal(f.store.get(f.id).findings[0].review_worker, null);
    assert.equal(f.store.claim(f.id, "retry", 0), null, "a stopped project returns no job");
  } finally {
    f.close();
  }
});
