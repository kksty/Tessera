import { recordReview } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { createProjectSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { confirmedFinding, confirmedVulnerability } from "../../apps/web/src/project-activity.js";
import { scoreCvss, severityFromScore } from "../../packages/core/src/cvss.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

function fixture(severity: "critical" | "high" | "low" = "high") {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Review grading", origin: "https://example.test", goal: "Verify" })).project.id;
  const step = store.manualStep(id, { from: ["origin"], description: "Verify impact", creator: "human", claim: true });
  const evidence = store.addEvidence(id, { title: "Raw response", content: "observed response", encoding: "utf8", mime_type: "text/plain" });
  const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({ ...reportFields, title: "Impact", description: "Observed impact", evidence_ids: [evidence.id], severity, severity_reason: "Initial assessment" }));
  store.manualConclude(id, step.id, "human", "Finished observations");
  return { store, id, fid: finding.id };
}

test("review derives final severity from the vector while preserving the pre-review marker and export", () => {
  for (const [before, after] of [["critical", "low"], ["low", "critical"]] as const) {
    const { store, id, fid } = fixture(before);
    try {
      const vector = after === "critical" ? cvss.critical : cvss.low;
      const job = store.claim(id, "reviewer", deferDecideMs)!;
      assert.equal(job.kind, "review");
      const review = store.review(id, fid, reviewSchema.parse({ kind: "vulnerability", worker: job.worker, finding_version: job.finding_version,
        verdict: "pass", reason: "Evidence verified", evidence_ids: [store.get(id).findings[0].evidence_ids[0]],
        cvss: { ...vector, rationale: "Measured scope and prerequisites" } }));
      const finding = store.get(id).findings[0];
      const expected = severityFromScore(scoreCvss(vector).score);
      assert.equal(finding.version, 1);
      assert.equal(finding.severity_before_review, before);
      assert.equal(finding.severity_reason_before_review, "Initial assessment");
      assert.equal(finding.severity, expected);
      assert.equal(review.severity, expected);
      assert.equal(review.severity_before_review, before);
      assert.ok(confirmedFinding(finding));
      const reports = new Reports(store), snapshot = reports.create(id);
      assert.equal(snapshot.material.findings[0].severity, expected);
      assert.match(reports.markdown(snapshot), /复审前危险度（仅作历史标记）/);
      store.reviseFinding(id, fid, { severity: "medium", severity_reason: "New evidence" }, 1);
      const revised = store.get(id).findings[0];
      assert.equal(revised.version, 2);
      assert.equal(revised.severity_before_review, undefined);
      assert.equal(confirmedFinding(revised), false);
      assert.equal(store.get(id).reviews[0].severity_before_review, before);
      assert.equal(reports.list(id)[0].stale, true);
    } finally { store.close(); }
  }
});

test("null severity needs no grading rationale while actual ratings and vulnerability proof remain validated", () => {
  for (const [kind, verdict] of [["informational", "pass"], ["vulnerability", "needs_evidence"]] as const) {
    const { store, id, fid } = fixture();
    try {
      const job = store.claim(id, "reviewer", deferDecideMs)!;
      const base = { worker: job.worker, finding_version: 1, reason: "Existing evidence checked",
        evidence_ids: store.get(id).findings[0].evidence_ids };
      const before = store.get(id);
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, kind: "vulnerability", verdict: "needs_evidence",
        severity: "high" })), /Review severity requires severity_reason/);
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, kind: "vulnerability", verdict: "pass",
        severity: null })), /requires a CVSS/);
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, kind: "informational", verdict: "pass",
        severity: "high", severity_reason: "Proposed rating" })), /Informational reviews have no severity or CVSS/);
      assert.deepEqual(store.get(id), before, "invalid reviews leave the graph and lease unchanged");
      const result = store.review(id, fid, reviewSchema.parse({ ...base, kind, verdict, severity: null }));
      const finding = store.get(id).findings[0];
      assert.equal(result.severity, null);
      assert.equal(result.severity_reason, undefined);
      assert.equal(finding.severity, null);
      assert.equal(finding.severity_reason, undefined, "null must not inherit the provisional rating rationale");
      assert.equal(finding.cvss, null);
      assert.equal(finding.severity_before_review, "high");
      assert.equal(finding.severity_reason_before_review, "Initial assessment");
      assert.equal(finding.review_status, verdict);
      assert.equal(confirmedVulnerability(finding), false);
    } finally { store.close(); }
  }
});

test("a passing vulnerability review requires a vector; unknown impact needs evidence and informational is explicit", () => {
  // No vector and no explicit non-vulnerability severity: the old high value would leak.
  {
    const { store, id, fid } = fixture();
    try {
      const job = store.claim(id, "reviewer", deferDecideMs)!;
      const base = { kind: "vulnerability", worker: job.worker, finding_version: job.finding_version, verdict: "pass", reason: "Evidence verified" };
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, evidence_ids: [store.get(id).findings[0].evidence_ids[0]] })),
        /requires a CVSS/);
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, severity: "critical", severity_reason: "Guess",
        evidence_ids: [store.get(id).findings[0].evidence_ids[0]] })), /requires a CVSS/);
      assert.throws(() => store.review(id, fid, reviewSchema.parse({ ...base, severity: null, severity_reason: "Impact unknown",
        evidence_ids: [store.get(id).findings[0].evidence_ids[0]] })), /requires a CVSS/);
      const partial = store.review(id, fid, reviewSchema.parse({ ...base, verdict: "needs_evidence", severity: null, severity_reason: "Impact scope not established",
        evidence_ids: [store.get(id).findings[0].evidence_ids[0]] }));
      assert.equal(store.get(id).findings[0].severity, null);
      assert.equal(partial.severity, null);
    } finally { store.close(); }
  }
  // Informational is the explicit non-vulnerability form and needs no vector.
  {
    const { store, id, fid } = fixture();
    try {
      const job = store.claim(id, "reviewer", deferDecideMs)!;
      store.review(id, fid, reviewSchema.parse({ kind: "informational", worker: job.worker, finding_version: job.finding_version,
        verdict: "pass", reason: "No target impact", severity: "informational", severity_reason: "Not a vulnerability",
        evidence_ids: [store.get(id).findings[0].evidence_ids[0]] }));
      const finding = store.get(id).findings[0];
      assert.equal(finding.kind, "informational");
      assert.equal(finding.severity, null);
      assert.ok(!finding.cvss);
      assert.equal(confirmedFinding(finding), true);
      assert.equal(confirmedVulnerability(finding), false, "informational is not a vulnerability");
    } finally { store.close(); }
  }
  // Manual operator confirmation follows the same rule.
  {
    const { store, id, fid } = fixture();
    try {
      assert.throws(() => recordReview(store, id, fid, "confirmed", "operator", "Checked", "vulnerability"),
        /requires a CVSS/);
      store.reviseFinding(id, fid, { cvss: cvss.high });
      recordReview(store, id, fid, "confirmed", "operator", "Checked", "vulnerability");
      assert.equal(store.get(id).findings[0].severity, "high");
    } finally { store.close(); }
  }
  // A vector is authoritative even when the reviewer proposes another severity.
  {
    const { store, id, fid } = fixture("low");
    try {
      const job = store.claim(id, "reviewer", deferDecideMs)!;
      store.review(id, fid, reviewSchema.parse({ kind: "vulnerability", worker: job.worker, finding_version: job.finding_version,
        verdict: "pass", reason: "Reproduced", severity: "low", severity_reason: "Proposal",
        cvss: { ...cvss.critical, rationale: "Unauthenticated high-impact issue" },
        evidence_ids: [store.get(id).findings[0].evidence_ids[0]] }));
      const finding = store.get(id).findings[0];
      assert.equal(finding.severity, "critical", "the computed score wins over the reviewer's severity");
      assert.equal(finding.cvss?.score, 9.3);
    } finally { store.close(); }
  }
});
