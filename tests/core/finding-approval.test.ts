import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { humanApproved } from "../../packages/protocol/src/finding-policy.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Approval", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "Raw response",
    content: "server: nginx/1.24",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      title: "Exposed admin page",
      description: "The admin page is reachable without authentication.",
      from: ["origin"],
      evidence_ids: [evidence.id],
      kind: "vulnerability",
    }),
  );
  return { store, id, evidence, finding };
}

test("an operator approval settles the finding and removes it from pending queues", () => {
  const f = fixture();
  try {
    assert.equal(findingPending(f), 1, "the new claim is waiting for Review");
    const approved = f.store.setFindingApproval(f.id, f.finding.id, {
      approved: true,
      expected_version: f.finding.version,
      creator: "operator",
      reason: "Confirmed by the operator",
    });
    assert.equal(humanApproved(approved), true);
    assert.equal(approved.human_approval?.by, "operator");
    assert.equal(approved.human_approval?.version, f.finding.version);
    // Approved findings leave the Review queue, the nav badge and the overview counts.
    assert.equal(f.store.get(f.id).findings[0].human_approval!.version, f.finding.version);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 0);
    assert.equal(f.store.overview().totals.pending_review, 0);

    const unapproved = f.store.setFindingApproval(f.id, f.finding.id, {
      approved: false,
      expected_version: f.finding.version,
      creator: "operator",
    });
    assert.equal(humanApproved(unapproved), false);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
  } finally {
    f.store.close();
  }
});

test("approval is version-bound, idempotent and rejects stale versions", () => {
  const f = fixture();
  try {
    f.store.setFindingApproval(f.id, f.finding.id, {
      approved: true,
      expected_version: f.finding.version,
      creator: "operator",
    });
    // Approving again keeps the same settled state (no error for a repeated click).
    const again = f.store.setFindingApproval(f.id, f.finding.id, {
      approved: true,
      expected_version: f.finding.version,
      creator: "operator",
    });
    assert.equal(humanApproved(again), true);
    assert.throws(
      () =>
        f.store.setFindingApproval(f.id, f.finding.id, {
          approved: true,
          expected_version: f.finding.version + 1,
          creator: "operator",
        }),
      /版本已更新/,
    );
    // A revision is a new claim: the approval does not carry over.
    const revised = f.store.reviseFinding(f.id, f.finding.id, { title: "Exposed admin page (revised)" });
    assert.equal(revised.version, f.finding.version + 1);
    assert.equal(humanApproved(revised), false, "a new version must be approved again");
    assert.equal(revised.human_approval, undefined);
    assert.equal(pendingReviews(f.store.get(f.id)).length, 1);
  } finally {
    f.store.close();
  }
});

test("a rejected finding cannot be approved", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.reject", false, (g) => {
      g.findings[0].status = "rejected";
      g.findings[0].review_status = "rejected";
    });
    assert.throws(
      () =>
        f.store.setFindingApproval(f.id, f.finding.id, {
          approved: true,
          expected_version: f.finding.version,
          creator: "operator",
        }),
      /驳回/,
    );
  } finally {
    f.store.close();
  }
});

function findingPending(f: ReturnType<typeof fixture>) {
  return pendingReviews(f.store.get(f.id)).length;
}
