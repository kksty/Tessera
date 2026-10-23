import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema, type Review } from "../../packages/protocol/src/index.js";
import { reviewedFindingSnapshot, reviewVersionLabel } from "../../apps/web/src/review-history.js";

test("historical reviews retain the reviewed title and entry point rather than the current revision", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "History", origin: "https://example.test", goal: "Assess" })).project.id;
    const f = store.submitFinding(id, findingSchema.parse({ title: "Original title", description: "Original description",
      identity: { category: "access_control", host: "example.test", path: "/original" } }));
    const review: Review = { id: "r002", finding_id: f.id, finding_version: 1, verdict: "needs_evidence", reason: "Correct count",
      evidence_ids: [], disputed_fact_ids: [], created_at: f.created_at, worker: "reviewer" };
    store.reviseFinding(id, f.id, { title: "Corrected title", identity: { category: "access_control", host: "example.test", path: "/revised" } });
    const current = store.get(id).findings[0], snapshot = reviewedFindingSnapshot(current, review);
    assert.equal(snapshot?.title, "Original title");
    assert.equal(snapshot?.identity?.path, "/original");
    assert.equal(reviewVersionLabel(review), "发现 v001 · 第 1 版");
    assert.equal(reviewedFindingSnapshot(current, { ...review, finding_version: 2 })?.title, "Corrected title");
    assert.equal(reviewedFindingSnapshot({ ...current, edits: [] }, review), undefined, "never invent unavailable historical text");
  } finally { store.close(); }
});
