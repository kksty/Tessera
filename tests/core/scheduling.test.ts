import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { pendingReviews, reviewGate } from "../../packages/protocol/src/review-scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Scheduling", origin: "https://example.test", goal: "Assess" })).project.id;
  for (let i = 0; i < 4; i++) {
    store.manualStep(id, { from: ["origin"], description: `Execute ${i}`, creator: "fixture" });
    store.submitFinding(id, findingSchema.parse({ title: `Claim ${i}`, description: `Independent claim ${i}`, from: ["origin"] }));
  }
  const settle = (worker: string) => {
    const g = store.get(id);
    commitPlan(store, id, decideSchema.parse({ worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision }));
  };
  return { store, id, settle };
}

test("due Decide takes the next slot before reviews, then single-slot Execute and Review alternate", () => {
  const f = fixture(), limits = { max_project_workers: 1 };
  try {
    f.store.mutate(f.id, "", false, g => { g.project.job_failures = { decide: 1 }; g.project.decide_retry_at = "2000-01-01T00:00:00Z"; });
    const first = f.store.claim(f.id, "planner", 0, limits)!;
    assert.equal(first.kind, "decide");
    assert.equal(f.store.claim(f.id, "no-slot", 0, limits), null);
    f.settle(first.worker);
    const before = f.store.get(f.id);
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const job = f.store.claim(f.id, `w${i}`, 0, limits)!;
      kinds.push(job.kind);
      f.store.release(f.id, job);
    }
    assert.deepEqual(kinds, ["execute", "review", "execute", "review", "execute", "review"]);
    const after = f.store.get(f.id);
    assert.equal(after.observation_revision, before.observation_revision);
    assert.equal(after.decided_revision, before.decided_revision);
    f.store.hint(f.id, "New planning input while queues remain ready");
    assert.equal(f.store.claim(f.id, "new-planner", 0, limits)?.kind, "decide");
  } finally { f.store.close(); }
});

test("the work rotation cursor survives restart without acknowledging unseen observations", () => {
  const directory = mkdtempSync(join(tmpdir(), "tessera-schedule-")), path = join(directory, "graph.db");
  let store = new Store(path);
  try {
    const id = store.create(createProjectSchema.parse({ title: "Rotation", origin: "https://example.test", goal: "Assess" })).project.id;
    store.manualStep(id, { from: ["origin"], description: "Run", creator: "fixture" });
    store.submitFinding(id, findingSchema.parse({ title: "Claim", description: "Existing claim", from: ["origin"] }));
    const planner = store.claim(id, "planner", 0)!, g = store.get(id);
    commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision }));
    const execute = store.claim(id, "execute", 0)!;
    assert.equal(execute.kind, "execute");
    store.release(id, execute);
    const before = store.get(id);
    store.close(); store = new Store(path);
    assert.equal(store.claim(id, "review", 0)?.kind, "review");
    assert.equal(store.get(id).decided_revision, before.decided_revision);
    assert.equal(store.get(id).observation_revision, before.observation_revision);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Review cap leaves slots for Execute; lowering limits does not preempt existing leases", () => {
  const f = fixture();
  try {
    f.store.claim(f.id, "planner", 0); f.settle("planner");
    const jobs = Array.from({ length: 4 }, (_, i) => f.store.claim(f.id, `w${i}`, 0)!);
    assert.deepEqual(jobs.map(j => j.kind), ["execute", "review", "execute", "execute"]);
    assert.equal(f.store.claim(f.id, "full", 0), null);
    const reviews = f.store.get(f.id).findings.filter(v => v.review_worker);
    assert.equal(reviews.length, 1);
    assert.equal(f.store.claim(f.id, "lowered", 0, { max_project_workers: 1 }), null);
    for (const job of jobs) assert.doesNotThrow(() => f.store.heartbeat(f.id, job));
  } finally { f.store.close(); }
});

test("numeric Review order skips blocked entries and restores them when eligible", () => {
  const f = fixture();
  try {
    f.store.claim(f.id, "planner", 0); f.settle("planner");
    f.store.mutate(f.id, "", false, g => {
      g.steps.forEach(s => { s.concluded_at = "done"; });
      g.findings.forEach((v, i) => { v.id = ["v1000", "v999", "v002", "v001"][i]; });
      g.findings[3].retry_at = new Date(Date.now() + 60000).toISOString();
      g.findings[2].revision_step_id = "missing-step";
    });
    let g = f.store.get(f.id);
    assert.deepEqual(pendingReviews(g).map(row => row.finding.id), ["v999", "v1000", "v001", "v002"]);
    assert.equal(reviewGate(g, g.findings[2]), "source_unfinished");
    const review = f.store.claim(f.id, "reviewer", 0)!;
    assert.equal(review.finding_id, "v999");
    assert.equal(f.store.claim(f.id, "capped", 0), null);
    f.store.release(f.id, review);
    f.store.mutate(f.id, "", false, g => { g.findings[3].retry_at = "2000-01-01T00:00:00Z"; });
    assert.equal(f.store.claim(f.id, "earliest", 0)?.finding_id, "v001");
    g = f.store.get(f.id);
    assert.equal(reviewGate(g, g.findings[0]), "review_limit");
  } finally { f.store.close(); }
});

test("a running Decide prevents another Decide while Review backoff, approval and pause gates hold", () => {
  const f = fixture();
  try {
    assert.equal(f.store.claim(f.id, "planner", 0)?.kind, "decide");
    f.store.mutate(f.id, "", false, g => {
      g.steps.forEach(s => { s.blocked_run_id = "uncertain"; });
      g.findings[0].withdrawn_at = "withdrawn";
      g.findings[1].merged_into = g.findings[2].id;
      g.findings[2].asset_id = "unapproved";
      g.findings[3].retry_at = new Date(Date.now() + 60000).toISOString();
    });
    assert.equal(f.store.claim(f.id, "blocked", 0), null);
    const g = f.store.get(f.id);
    assert.equal(reviewGate(g, g.findings[2]), "asset_unapproved");
    f.store.status(f.id, "stopped");
    assert.equal(f.store.claim(f.id, "paused", 0), null);
  } finally { f.store.close(); }
});
