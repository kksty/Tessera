import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import {
  createProjectSchema,
  findingSchema,
  findingKind,
  confirmedInformational,
  informationalReviewExempt,
  reviewSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Review scope", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "Raw response",
    content: "server: nginx/1.24",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const submit = (kind: "informational" | "vulnerability" | null, extra: Record<string, unknown> = {}) =>
    store.submitFinding(
      id,
      findingSchema.parse({
        title: `${kind ?? "unclassified"} claim`,
        description: "Supported conclusion",
        from: ["origin"],
        evidence_ids: [evidence.id],
        kind,
        ...extra,
      }),
    );
  return { store, id, evidence, submit };
}

test("default review scope still queues informational findings", () => {
  const f = fixture();
  try {
    const finding = f.submit("informational");
    assert.equal(finding.review_status, "pending");
    assert.equal(finding.review_exempt, undefined);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
  } finally {
    f.store.close();
  }
});

test("vulnerability-only scope accepts evidence-backed information without a Review run", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    const finding = f.submit("informational");
    assert.equal(finding.review_status, "pass");
    assert.equal(finding.status, "confirmed");
    assert.equal(finding.reviewed_version, finding.version);
    assert.equal(finding.review_exempt, "informational");
    assert.equal(informationalReviewExempt(finding), true);
    const graph = f.store.get(f.id);
    assert.equal(confirmedInformational(graph.findings[0], graph), true);
    assert.equal(pendingReviews(graph).length, 0);
    assert.equal(graph.reviews.length, 1);
    assert.equal(graph.reviews[0].source, "system");
    assert.equal(graph.reviews[0].verdict, "pass");
    assert.equal(f.store.overview().totals.informational, 1);
    assert.equal(f.store.allFindings()[0].confirmed, false, "information never enters the vulnerability library");
    assert.equal(reportMaterial(graph).excluded.informational, 1);
    assert.equal(reportMaterial(graph).findings.length, 0);
    assert.equal(f.store.claim(f.id, "reviewer", deferDecideMs), null, "no Review job is emitted");
  } finally {
    f.store.close();
  }
});

test("vulnerability and unclassified claims still go to Review under the switch", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    f.submit("informational");
    const vulnerability = f.submit("vulnerability");
    const unclassified = f.submit(null);
    const graph = f.store.get(f.id);
    assert.equal(pendingReviews(graph).length, 2);
    assert.equal(vulnerability.review_status, "pending");
    assert.equal(unclassified.review_status, "pending");
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
    assert.equal(job.finding_id, vulnerability.id);
  } finally {
    f.store.close();
  }
});

test("information without raw evidence still needs Review", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    const finding = f.store.submitFinding(
      f.id,
      findingSchema.parse({
        title: "Unsourced note",
        description: "No evidence attached",
        kind: "informational",
      }),
    );
    assert.equal(finding.review_status, "pending");
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
  } finally {
    f.store.close();
  }
});

test("switching the scope settles findings already queued for informational Review", () => {
  const f = fixture();
  try {
    const finding = f.submit("informational");
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
    f.store.setSkipInformationalReview(true);
    const graph = f.store.get(f.id),
      settled = graph.findings.find((item) => item.id === finding.id)!;
    assert.equal(settled.review_status, "pass");
    assert.equal(settled.review_exempt, "informational");
    assert.equal(pendingReviews(graph).length, 0);
    assert.equal(graph.reviews.length, 1);
  } finally {
    f.store.close();
  }
});

test("informational revisions keep skipping Review until a human asks for evidence", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    const finding = f.submit("informational");
    const revised = f.store.reviseFinding(f.id, finding.id, { title: "Revised information" });
    assert.equal(revised.version, 2);
    assert.equal(revised.review_status, "pass");
    assert.equal(revised.review_exempt, "informational");
    assert.equal(pendingReviews(f.store.get(f.id)).length, 0);

    const changed = f.store.reviseFinding(f.id, finding.id, { kind: "vulnerability" });
    assert.equal(changed.review_status, "pending");
    assert.equal(changed.review_exempt, undefined);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
  } finally {
    f.store.close();
  }
});

test("a human return keeps the finding in Review even if it is reclassified as informational", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    const finding = f.submit("informational");
    f.store.findingAction(f.id, finding.id, {
      action: "return",
      expected_version: finding.version,
      creator: "operator",
      reason: "Show the exact response for this claim",
    });
    const revised = f.store.reviseFinding(f.id, finding.id, { title: "Information with operator feedback" });
    assert.equal(revised.human_feedback?.action, "return");
    assert.equal(revised.review_status, "pending");
    assert.equal(revised.review_exempt, undefined);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
  } finally {
    f.store.close();
  }
});

test("Decide classifying a revision as informational skips Review under the switch", () => {
  const f = fixture();
  try {
    f.store.setSkipInformationalReview(true);
    const finding = f.submit("vulnerability");
    const job = f.store.claim(f.id, "planner", deferDecideMs)!;
    assert.equal(job.kind, "review", "the vulnerability claim is reviewed first");
    f.store.review(
      f.id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "needs_evidence",
        reason: "Impact is not demonstrated",
      }),
    );
    const planned = f.store.claim(f.id, "planner", 0)!;
    assert.equal(planned.kind, "decide");
    const graph = f.store.get(f.id);
    f.store.submitDecisions(
      f.id,
      submitDecisionsSchema.parse({
        worker: planned.worker,
        submission_id: "informational-reclass",
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        finding_updates: [
          {
            id: finding.id,
            expected_version: finding.version,
            reason: "Only banner disclosure; record as information",
            changes: { kind: "informational", title: "Server banner" },
          },
        ],
      }),
      planned.run_id,
    );
    const updated = f.store.get(f.id).findings[0];
    assert.equal(findingKind(updated), "informational");
    assert.equal(updated.review_status, "pass");
    assert.equal(updated.review_exempt, "informational");
    assert.equal(pendingReviews(f.store.get(f.id)).length, 0);
  } finally {
    f.store.close();
  }
});
