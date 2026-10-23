import { recordReview } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import { findingQualityPolicy, reviewImpactPolicy } from "../../packages/runner/src/prompts.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema, reviewSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";
import { cvss, withImpactEvidence } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { duplicateFindingGroups, relatedFindingGroups } from "../../packages/core/src/finding-merges.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Finding quality", origin: "https://example.test", goal: "Verify real impact" })).project.id;
  const proof = (title: string) => store.addEvidence(id, { title, content: "Original response", encoding: "utf8", mime_type: "text/plain" });
  const first = proof("First proof"), second = proof("Complementary proof");
  const identity = { category: "access_control", host: "example.test", protocol: "https", path: "/records", parameter: "id" };
  const finding = (title: string, evidence = first.id) => store.submitFinding(id, findingSchema.parse({
    ...reportFields, title, description: `${title} details`, identity, from: ["origin"], evidence_ids: [evidence],
  }));
  const settle = (worker: string, submission_id: string, payload: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(id, submitDecisionsSchema.parse({ worker, submission_id,
      revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision, ...payload }));
  };
  return { store, id, first, second, identity, finding, settle };
}

test("shared API entry points surface semantic comparison without automatically treating CORS and access control as duplicates", () => {
  const f = fixture();
  try {
    const first = f.finding("Unauthenticated records");
    const second = f.store.submitFinding(f.id, findingSchema.parse({ ...reportFields, title: "CORS headers", description: "Independent claim to assess",
      evidence_ids: [f.second.id], identity: { ...f.identity, category: "cors", parameter: "Origin" } }));
    const graph = f.store.get(f.id);
    assert.equal(duplicateFindingGroups(graph.findings).length, 0);
    assert.deepEqual(relatedFindingGroups(graph.findings)[0].finding_ids, [first.id, second.id]);
    const view = memoryEntry(graph, { kind: "decide", project_id: f.id, worker: "planner", graph_id: "main" }) as any;
    assert.deepEqual(view.finding_related[0].finding_ids, [first.id, second.id]);
    assert.match(view.finding_related[0].instruction, /独立影响/);
    assert.equal(f.store.get(f.id).findings.length, 2);
    graph.findings[1].identity!.host = "other.test";
    assert.equal(relatedFindingGroups(graph.findings).length, 0);
    graph.findings[1].identity = first.identity;
    assert.equal(duplicateFindingGroups(graph.findings).length, 1);
    assert.equal(relatedFindingGroups(graph.findings).length, 0, "exact duplicates need only one comparison group");
    graph.findings[1].deleted = { at: "now", by: "planner", submission_id: "fixture", reason: "Removed", root_id: second.id, cascade: "none" };
    assert.equal(relatedFindingGroups(graph.findings).length, 0);
  } finally { f.store.close(); }
});

test("incremental delivery and rewritten final output revise one Finding and preserve all evidence", () => {
  const f = fixture();
  try {
    const step = f.store.manualStep(f.id, { from: ["origin"], description: "Inspect records", creator: "human", claim: true });
    const input = { ...reportFields, title: "Record disclosure", description: "Original details", identity: f.identity,
      evidence_ids: [f.first.id], from: ["origin"], severity: "medium" as const };
    const first = f.store.submitStepFinding(f.id, step.id, "human", findingSchema.parse(input));
    const replay = f.store.submitStepFinding(f.id, step.id, "human", findingSchema.parse(input));
    assert.equal(replay.id, first.id);
    assert.equal(replay.version, 1);
    f.store.execute(f.id, step.id, executeSchema.parse({ worker: "human", findings: [{ ...input,
      description: "Rewritten final summary", evidence: "Shorter evidence excerpt", remediation: "Enforce ownership",
      evidence_ids: [f.second.id] }] }));
    const graph = f.store.get(f.id);
    assert.equal(graph.findings.length, 1);
    assert.equal(graph.findings[0].version, 2);
    assert.deepEqual(graph.findings[0].evidence_ids, [f.first.id, f.second.id]);
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    f.store.review(f.id, first.id, reviewSchema.parse({ kind: "vulnerability", worker: job.worker, finding_version: 2,
      verdict: "pass", reason: "Read evidence", cvss: cvss.high }));
    f.store.submitFinding(f.id, findingSchema.parse({ ...input, description: "Rewritten final summary",
      evidence: "Shorter evidence excerpt", remediation: "Enforce ownership", evidence_ids: [f.second.id] }));
    assert.equal(f.store.get(f.id).findings.length, 1);
    assert.equal(f.store.get(f.id).findings[0].severity, "high", "replay cannot restore a provisional grade");
  } finally { f.store.close(); }
});

test("Decide merges graph nodes with provenance, cancels old reviews and re-reviews the target", () => {
  const f = fixture();
  try {
    const target = f.finding("First claim"), source = f.finding("Restated claim", f.second.id);
    f.store.reviseFinding(f.id, target.id, { cvss: withImpactEvidence(cvss.high, [f.first.id]) });
    recordReview(f.store, f.id, target.id, "confirmed", "human", "Original proof checked", "vulnerability");
    const review = f.store.claim(f.id, "source-reviewer", deferDecideMs)!;
    const planner = f.store.claim(f.id, "planner", 0)!;
    assert.equal(planner.kind, "decide");
    const before = f.store.get(f.id);
    const payload = { finding_merges: [{ target_id: target.id, source_ids: [source.id],
      expected_versions: Object.fromEntries(before.findings.map(v => [v.id, v.version])), reason: "Same root cause and boundary" }] };
    const request = submitDecisionsSchema.parse({ worker: planner.worker, submission_id: "merge-once",
      revision: before.revision, observation_revision: before.observation_revision, planning_revision: before.planning_revision, ...payload });
    const response = f.store.submitDecisions(f.id, request);
    assert.equal(response.settle.ok, true);
    const graph = f.store.get(f.id), merged = graph.findings.find(v => v.id === target.id)!;
    assert.equal(graph.findings.length, 2, "retain source records for audit");
    assert.equal(graph.findings.find(v => v.id === source.id)!.merged_into, target.id);
    assert.deepEqual(merged.evidence_ids, [f.first.id, f.second.id]);
    assert.equal(merged.version, 3);
    assert.equal(merged.cvss, null);
    assert.equal(merged.review_status, "pending");
    assert.equal(merged.edits?.at(-1)?.previous.cvss?.score, 7.9);
    assert.equal(graph.reviews.length, 1, "historical pass is retained");
    assert.equal(f.store.runs(f.id).find(r => r.id === review.run_id)?.status, "cancelled");
    assert.equal(f.store.allFindings().length, 1);
    assert.equal(reportMaterial(graph).findings.length, 0, "never inherit a pass through a merge");
    assert.deepEqual(f.store.submitDecisions(f.id, request), response);
    const fresh = f.store.claim(f.id, "merged-reviewer", deferDecideMs)!;
    const view = memoryEntry(f.store.get(f.id), fresh) as unknown as { merged_findings: { id: string }[] };
    assert.deepEqual(view.merged_findings.map(v => v.id), [source.id]);
    assert.throws(() => f.store.reviseFinding(f.id, source.id, { description: "Revive" }), /merged into/);
    assert.throws(() => recordReview(f.store, f.id, source.id, "confirmed", "human", "Revive", "vulnerability"), /merged into/);
  } finally { f.store.close(); }
});

test("stale graph edits leave all settlement nodes unchanged and merge groups stay visible when cold", () => {
  const f = fixture();
  try {
    const a = f.finding("A"), b = f.finding("B");
    const reviews = ["review-a", "review-b"].map(worker => f.store.claim(f.id, worker, deferDecideMs,
      { max_project_review_workers: 2 })!);
    assert.deepEqual(reviews.map(job => job.kind), ["review", "review"]);
    const planner = f.store.claim(f.id, "planner", 0)!;
    f.store.mutate(f.id, "", false, g => { g.project.hot_limit = 1; g.project.decision_round = 10;
      g.findings.forEach(v => { v.last_referenced_round = 0; }); });
    const view = memoryEntry(f.store.get(f.id), planner) as unknown as { finding_duplicates: { finding_ids: string[] }[] };
    assert.deepEqual(view.finding_duplicates[0].finding_ids, [a.id, b.id]);
    const before = f.store.get(f.id).findings;
    const result = f.settle(planner.worker, "stale", { finding_merges: [{ target_id: a.id, source_ids: [b.id],
      expected_versions: { [a.id]: 1, [b.id]: 2 }, reason: "Stale merge" }] });
    assert.equal(result.settle.ok, false);
    assert.match(result.settle.conflicts[0].reason, /version changed/);
    assert.deepEqual(f.store.get(f.id).findings, before);
    const completion = f.settle(planner.worker, "no-duplicates", { complete: { from: ["origin"], description: "Done" } });
    assert.equal(completion.settle.ok, false);
    assert.match(completion.settle.conflicts[0].reason, /Merge duplicate/);
  } finally { f.store.close(); }
});

test("Decide can revise findings directly but cannot write grades, evidence bytes or review verdicts", () => {
  const f = fixture();
  try {
    const a = f.finding("Old claim");
    f.store.claim(f.id, "reviewer", deferDecideMs);
    const planner = f.store.claim(f.id, "planner", 0)!;
    const updated = f.settle(planner.worker, "edit", { finding_updates: [{ id: a.id, expected_version: 1,
      reason: "Correct unsupported impact", changes: { title: "Revised claim", impact: "Impact still needs verification" } }] });
    assert.equal(updated.settle.ok, true);
    const record = f.store.get(f.id).findings[0];
    assert.equal(record.title, "Revised claim");
    assert.equal(record.version, 2);
    assert.equal(record.review_status, "pending");
    assert.equal(record.edits?.[0].previous.title, "Old claim");
    const base = { worker: "planner", revision: 1, observation_revision: 1,
      finding_updates: [{ id: a.id, expected_version: 2, reason: "Edit", changes: { status: "confirmed" } }] };
    assert.throws(() => decideSchema.parse(base), /Unrecognized key/);
    assert.throws(() => decideSchema.parse({ ...base, finding_updates: [], finding_merges: [
      { target_id: a.id, source_ids: [a.id], expected_versions: { [a.id]: 1 }, reason: "Self merge" }] }), /only once/);
  } finally { f.store.close(); }
});

test("every claimed CVSS impact requires bound proof regardless of vulnerability category", () => {
  const f = fixture();
  try {
    const finding = f.finding("Unclassified issue"), job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    const base = { kind: "vulnerability", worker: job.worker, finding_version: finding.version, verdict: "pass", reason: "Claimed impact" };
    const vector = { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", rationale: "Observed effect" };
    assert.throws(() => f.store.review(f.id, finding.id, reviewSchema.parse({ ...base, cvss: vector })), /VC requires impact_evidence/);
    assert.throws(() => f.store.review(f.id, finding.id, reviewSchema.parse({ ...base,
      cvss: withImpactEvidence(vector, [f.second.id]) })), /must reference/);
    const proof = withImpactEvidence(vector);
    assert.throws(() => f.store.review(f.id, finding.id, reviewSchema.parse({ ...base,
      cvss: { ...proof, impact_evidence: [...proof.impact_evidence!, ...proof.impact_evidence!] } })), /Duplicate impact/);
    assert.throws(() => f.store.review(f.id, finding.id, reviewSchema.parse({ ...base,
      cvss: { ...cvss.high, impact_evidence: proof.impact_evidence } })), /contradicts VC:N/);
    const passed = f.store.review(f.id, finding.id, reviewSchema.parse({ ...base, cvss: proof }));
    assert.equal(passed.cvss?.score, 6.9, "proof rules do not alter the standard CVSS formula");
    assert.equal(passed.cvss?.impact_evidence?.[0].metric, "VC");
    assert.equal(f.store.claim(f.id, "planner-after-pass", 0)?.kind, "decide", "Decide must consume the final grade");
    assert.ok(findingQualityPolicy.includes("所有漏洞类别"));
    assert.ok(reviewImpactPolicy.includes("impact_evidence"));
  } finally { f.store.close(); }
});

test("Decide can withdraw unsupported deliverables without removing observed facts or audit history", () => {
  const f = fixture();
  try {
    const finding = f.finding("Configuration observation");
    f.store.reviseFinding(f.id, finding.id, { cvss: cvss.high });
    recordReview(f.store, f.id, finding.id, "confirmed", "human", "Old assessment", "vulnerability");
    const planner = f.store.claim(f.id, "planner", 0)!;
    const before = f.store.get(f.id);
    const result = f.settle(planner.worker, "withdraw", { finding_updates: [{ id: finding.id, expected_version: 2,
      reason: "Only a configuration observation; no proved security impact", withdraw: true }],
      complete: { from: ["origin"], description: "No further valuable leads" } });
    assert.equal(result.settle.ok, true);
    const graph = f.store.get(f.id), record = graph.findings[0];
    assert.equal(graph.project.status, "completed");
    assert.ok(record.withdrawn_at);
    assert.equal(record.edits?.at(-1)?.previous.cvss?.score, 7.9);
    const observed = (facts: typeof graph.facts) => facts.map(({ last_referenced_round, last_read_round, ...fact }) => fact);
    assert.deepEqual(observed(graph.facts), observed(before.facts));
    assert.deepEqual(graph.evidence, before.evidence);
    assert.deepEqual(graph.reviews, before.reviews);
    assert.equal(f.store.allFindings().length, 0);
    assert.equal(reportMaterial(graph).findings.length, 0);
    assert.throws(() => recordReview(f.store, f.id, finding.id, "confirmed", "human", "Stale decision", "vulnerability"), /completed|withdrawn/);
  } finally { f.store.close(); }
});
