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
  planningRevision,
  searchState,
} from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const graph = store.create(
      createProjectSchema.parse({ title: "Planning", origin: "https://example.test", goal: "Assess" }),
    ),
    id = graph.project.id;
  const evidence = store.addEvidence(id, {
    title: "Original",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      ...reportFields,
      title: "Claim",
      description: "Supported claim",
      evidence_ids: [evidence.id],
    }),
  );
  const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
  const planner = store.claim(id, "planner", 0)!;
  const snapshot = store.get(id);
  const complete = (extra = {}) =>
    store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker: planner.worker,
        submission_id: "finish",
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: planningRevision(snapshot),
        complete: { from: ["origin"], description: "Stop with documented limitations" },
        ...extra,
      }),
      planner.run_id,
    );
  const review = (extra = {}) =>
    store.review(
      id,
      finding.id,
      reviewSchema.parse({
        worker: reviewer.worker,
        finding_version: 1,
        verdict: "pass",
        kind: "vulnerability",
        reason: "Original proof inspected",
        cvss: cvss.high,
        ...extra,
      }),
    );
  return { store, id, evidence, finding, reviewer, planner, snapshot, complete, review };
}

test("an ordinary pass in flight does not invalidate the observed planning snapshot or advance the old read watermark", () => {
  const f = fixture();
  try {
    f.review();
    const reviewed = f.store.get(f.id);
    assert.ok(reviewed.observation_revision > f.snapshot.observation_revision);
    assert.equal(planningRevision(reviewed), planningRevision(f.snapshot));
    assert.equal(f.complete().settle.ok, true);
    const completed = f.store.get(f.id);
    assert.equal(searchState(completed), "completed");
    assert.equal(
      completed.decided_revision,
      f.snapshot.observation_revision,
      "ordinary pass is not silently acknowledged as read",
    );
    assert.equal(completed.decided_planning_revision, completed.planning_revision);
    assert.equal(f.store.claim(f.id, "idle", 0), null);
    assert.equal(f.store.events(f.id).find((e) => e.kind === "finding.reviewed")!.data.planning, false);
  } finally {
    f.store.close();
  }
});

test("explicit planning issues on pass reopen search; negative results can be acknowledged and stopped without endless retesting", () => {
  for (const verdict of ["pass", "needs_evidence", "rejected"] as const) {
    const f = fixture();
    try {
      f.complete();
      assert.equal(searchState(f.store.get(f.id)), "reviewing");
      const review = f.review({
        verdict,
        ...(verdict !== "pass" ? { cvss: undefined } : {}),
        planning_issues: ["Resolve a new independent question"],
      });
      const graph = f.store.get(f.id);
      assert.equal(searchState(graph), "exploring");
      assert.equal(graph.project.pending_completion, undefined);
      assert.ok(planningRevision(graph) > planningRevision(f.snapshot));
      assert.equal(graph.steps.length, 0, "Review does not create Execute work");
      const job = f.store.claim(f.id, "fresh", 0)!;
      assert.equal(job.kind, "decide");
      const read = f.store.get(f.id);
      commitPlan(
        f.store,
        f.id,
        decideSchema.parse({
          worker: job.worker,
          revision: read.revision,
          observation_revision: read.observation_revision,
          planning_revision: planningRevision(read),
          complete: {
            from: ["origin"],
            description: "Acknowledge the gap and stop; no further valuable test",
            review_issues: [
              {
                review_id: review.id,
                issue_index: 0,
                status: "waived",
                reason: "The question was reviewed and has no additional impact",
              },
            ],
          },
        }),
      );
      assert.equal(f.store.get(f.id).project.status, "completed");
    } finally {
      f.store.close();
    }
  }
});

test("usage, heartbeat, reads, bookmarks and cooling do not reopen a valid search completion", () => {
  const f = fixture();
  try {
    f.complete();
    const before = f.store.get(f.id),
      pending = structuredClone(before.project.pending_completion);
    f.store.heartbeat(f.id, f.reviewer);
    f.store.usage(f.id, f.reviewer, 100, 20, null, "request-1");
    f.store.recordRead(f.id, "origin");
    f.store.bookmark(f.id, f.reviewer.run_id!, {
      worker: f.reviewer.worker,
      node_id: "origin",
      expected_version: 0,
      reason: "Useful reference",
      revisit_when: "When scope changes",
      withdraw: false,
    });
    f.store.setCooldown(f.id, { hot_limit: 1 });
    const after = f.store.get(f.id);
    assert.equal(planningRevision(after), planningRevision(before));
    assert.deepEqual(after.project.pending_completion, pending);
    assert.equal(f.store.claim(f.id, "idle", 0), null);
    f.store.status(f.id, "stopped");
    assert.equal(f.store.claim(f.id, "paused", 0), null);
    f.store.status(f.id, "active");
    assert.equal(f.store.claim(f.id, "resumed", 0)?.kind, "decide");
  } finally {
    f.store.close();
  }
});

test("legacy completion proposals are not upgraded and historical decided_revision never implies the new planning acknowledgement", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(
        createProjectSchema.parse({ title: "Legacy", origin: "https://example.test", goal: "Assess" }),
      ),
      id = graph.project.id;
    delete graph.planning_revision;
    delete graph.decided_planning_revision;
    delete graph.last_planning_at;
    graph.decided_revision = graph.observation_revision;
    graph.project.pending_completion = {
      from: ["origin"],
      description: "Old proposal",
      worker: "old",
      graph_id: "main",
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
    };
    const wire = JSON.stringify(graph);
    store.db.prepare("UPDATE platform_projects SET data=? WHERE id=?").run(wire, id);
    assert.equal(searchState(store.get(id)), "exploring");
    assert.equal(store.db.prepare("SELECT data FROM platform_projects WHERE id=?").get(id)!.data, wire);
    const job = store.claim(id, "new-planner", 0)!;
    assert.equal(job.kind, "decide");
    assert.equal(store.get(id).decided_planning_revision, 0);
    assert.equal(store.get(id).project.status, "active");
    const read = store.get(id);
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: job.worker,
        revision: read.revision,
        observation_revision: read.observation_revision,
        planning_revision: planningRevision(read),
        complete: { from: ["origin"], description: "Reconfirmed from the new projection" },
      }),
    );
    assert.equal(store.get(id).project.status, "completed");
    store.hint(id, "New human direction after completion");
    assert.equal(store.get(id).project.status, "active");
    assert.equal(searchState(store.get(id)), "exploring");
    assert.equal(store.claim(id, "hint-planner", 0)?.kind, "decide");
  } finally {
    store.close();
  }
});

test("same-batch deletion and completion acknowledge only the observed planning state; new hints still conflict", () => {
  const f = fixture();
  try {
    const result = f.complete({ delete_nodes: [{ id: f.finding.id, reason: "No longer relevant", cascade: "none" }] });
    assert.equal(result.settle.ok, true);
    const graph = f.store.get(f.id);
    assert.ok(graph.planning_revision! > f.snapshot.planning_revision!);
    assert.equal(graph.planning_revision, graph.decided_planning_revision);
    assert.equal(graph.decided_revision, f.snapshot.observation_revision);
    assert.equal(graph.project.status, "completed");
    assert.equal(f.store.runs(f.id).find((r) => r.id === f.reviewer.run_id)!.status, "cancelled");
  } finally {
    f.store.close();
  }
  const stale = fixture();
  try {
    stale.store.hint(stale.id, "Unread instruction");
    assert.equal(stale.complete().settle.ok, false);
    assert.equal(stale.store.get(stale.id).decided_planning_revision, 0);
    assert.equal(stale.store.get(stale.id).project.status, "active");
  } finally {
    stale.store.close();
  }
});
