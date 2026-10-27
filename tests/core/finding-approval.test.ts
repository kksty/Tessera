import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { findingMergeConflicts, findingUpdateConflicts } from "../../packages/core/src/finding-merges.js";
import { createProjectSchema, deletionPreviewSchema, findingSchema } from "../../packages/protocol/src/index.js";
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

test("operator approval protects the Finding from Decide deletion, withdrawal and source-side merges", () => {
  const f = fixture();
  try {
    f.store.setFindingApproval(f.id, f.finding.id, {
      approved: true,
      expected_version: f.finding.version,
      creator: "operator",
    });
    const preview = f.store.previewDeletions(
      f.id,
      deletionPreviewSchema.parse({ delete_nodes: [{ id: f.finding.id, reason: "Retire claim" }] }).delete_nodes,
    );
    assert.equal(preview.valid, false);
    assert.match(preview.conflicts[0].reason, /Operator-approved/);
    const other = f.store.submitFinding(
      f.id,
      findingSchema.parse({
        title: "Related admin page",
        description: "The same admin page also exposes the build id.",
        from: ["origin"],
        evidence_ids: [f.evidence.id],
        kind: "vulnerability",
      }),
    );
    const graph = f.store.get(f.id);
    assert.deepEqual(
      findingUpdateConflicts(graph, [
        { id: f.finding.id, expected_version: 1, reason: "Retire claim", withdraw: true, changes: {} },
      ]),
      [
        {
          kind: "finding_update",
          id: f.finding.id,
          reason: "Operator-approved Finding cannot be withdrawn by Decide; ask the operator",
        },
      ],
    );
    const merges = [
      {
        target_id: other.id,
        source_ids: [f.finding.id],
        expected_versions: { [other.id]: 1, [f.finding.id]: 1 },
        reason: "Deduplicate the same admin page",
      },
    ];
    assert.ok(findingMergeConflicts(graph, merges).some((conflict) => /approved/.test(conflict.reason)));
    // The operator can still unapprove and then retire or merge the claim.
    f.store.setFindingApproval(f.id, f.finding.id, {
      approved: false,
      expected_version: f.finding.version,
      creator: "operator",
    });
    const current = f.store.get(f.id);
    assert.deepEqual(
      findingUpdateConflicts(current, [
        { id: f.finding.id, expected_version: 1, reason: "Retire claim", withdraw: true, changes: {} },
      ]),
      [],
    );
    assert.deepEqual(findingMergeConflicts(current, merges), []);
  } finally {
    f.store.close();
  }
});

function findingPending(f: ReturnType<typeof fixture>) {
  return pendingReviews(f.store.get(f.id)).length;
}
