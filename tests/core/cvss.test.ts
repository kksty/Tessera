import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { cvssScore, parseCvssVector, severityFromScore, scoreCvss, CvssError } from "../../packages/core/src/cvss.js";
import { withImpactEvidence } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

// Test vectors from the CVSS v4.0 specification's Base-score corpus.
const cases: [string, number][] = [
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 10.0],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N", 0.0],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", 9.3],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H", 7.9],
  ["CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", 1.0],
  ["CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L", 5.2],
];

test("CVSS v4.0 Base score matches the specification corpus", () => {
  for (const [vector, expected] of cases)
    assert.equal(cvssScore(vector), expected, `${vector} should score ${expected}`);
});

test("CVSS parsing rejects malformed, incomplete, duplicated and non-Base vectors", () => {
  assert.deepEqual(parseCvssVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), {
    AV: "N", AC: "L", AT: "N", PR: "N", UI: "N", VC: "H", VI: "H", VA: "H", SC: "N", SI: "N", SA: "N",
  });
  const invalid = [
    "CVSS:4.0/AV:F/AC:L/AT:N/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N",
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N/E:A",
    "AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N",
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:L/SC:N/SI:N/SA:N",
    "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N/AV:N",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  ];
  for (const vector of invalid) assert.throws(() => parseCvssVector(vector), CvssError, vector);
});

test("severity is derived from the computed score, never guessed", () => {
  assert.equal(severityFromScore(0), "none");
  assert.equal(severityFromScore(3.9), "low");
  assert.equal(severityFromScore(4.0), "medium");
  assert.equal(severityFromScore(6.9), "medium");
  assert.equal(severityFromScore(7.0), "high");
  assert.equal(severityFromScore(8.9), "high");
  assert.equal(severityFromScore(9.0), "critical");
  const record = scoreCvss({ vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", rationale: "Remote code execution" });
  assert.deepEqual(record, { version: "4.0",
    vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
    score: 9.3, rationale: "Remote code execution" });
  assert.equal(severityFromScore(record.score), "critical");
});

test("Review scores a verified finding; severity is derived and the model never supplies a score", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "CVSS", origin: "https://example.test", goal: "Assess" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Verify RCE", creator: "human", claim: true });
    const evidence = store.addEvidence(id, { title: "Proof", content: "id output", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({
      ...reportFields, title: "Remote code execution", description: "Command execution as the web user", evidence_ids: [evidence.id],
    }));
    store.manualConclude(id, step.id, "human", "Evidence captured");
    const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
    assert.equal(reviewer.kind, "review");
    const review = store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability",
      worker: reviewer.worker, finding_version: finding.version, verdict: "pass", reason: "Reproduced",
      evidence_ids: [evidence.id],
      cvss: withImpactEvidence({ vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", rationale: "Unauthenticated RCE" }),
    }));
    const stored = store.get(id).findings.find(f => f.id === finding.id)!;
    assert.equal(stored.cvss?.score, 9.3);
    assert.equal(stored.cvss?.version, "4.0");
    assert.equal(stored.cvss?.rationale, "Unauthenticated RCE");
    assert.equal(stored.severity, "critical", "severity is derived from the computed score");
    assert.equal(stored.severity_reason, "Unauthenticated RCE");
    assert.equal(stored.review_status, "pass");
    assert.deepEqual(review.cvss, stored.cvss);
  } finally { store.close(); }
});

test("a non-passing review cannot guess a score and a bad vector is rejected", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "CVSS invalid", origin: "https://example.test", goal: "Assess" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Verify", creator: "human", claim: true });
    const evidence = store.addEvidence(id, { title: "Proof", content: "output", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({
      title: "Claim", description: "Needs more evidence", evidence_ids: [evidence.id],
    }));
    store.manualConclude(id, step.id, "human", "Partial");
    const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
    const body = { worker: reviewer.worker, finding_version: finding.version, reason: "Not enough",
      evidence_ids: [evidence.id], cvss: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", rationale: "guess" } };
    assert.throws(() => store.review(id, finding.id, reviewSchema.parse({ ...body, verdict: "needs_evidence" })),
      /Only a passing review/);
    assert.throws(() => store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", ...body, verdict: "pass",
      cvss: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N", rationale: "missing SA" } })),
      /Invalid CVSS vector/);
    // An informational finding can pass without a vector.
    const passed = store.review(id, finding.id, reviewSchema.parse({ kind: "informational", worker: reviewer.worker,
      finding_version: finding.version, verdict: "pass", reason: "Configuration issue confirmed",
      evidence_ids: [evidence.id], severity: "informational", severity_reason: "No direct impact" }));
    assert.ok(passed.id);
    const stored = store.get(id).findings.find(f => f.id === finding.id)!;
    assert.equal(stored.kind, "informational");
    assert.equal(stored.severity, null);
    assert.equal(stored.cvss, null);
  } finally { store.close(); }
});

test("a passing re-review without a vector withdraws the old score but keeps it in review history", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Reattributed", origin: "https://example.test", goal: "Verify attribution" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Verify the endpoint", creator: "human", claim: true });
    const evidence = store.addEvidence(id, { title: "Raw response", content: "HTTP/1.1 502 Bad Gateway", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({
      ...reportFields, title: "Host forwarding", description: "Response follows the Host header", evidence_ids: [evidence.id], severity: "medium",
    }));
    store.manualConclude(id, step.id, "human", "Observed");
    const first = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: first.worker, finding_version: first.finding_version,
      verdict: "pass", reason: "Causal chain closed", severity_reason: "Initial scope",
      cvss: withImpactEvidence({ vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", rationale: "Limited read" }) }));
    assert.equal(store.get(id).findings[0].cvss?.score, 6.9);

    store.reviseFinding(id, finding.id, { description: "Answering party is the sandbox egress layer, not the target" }, 1);
    const second = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(id, finding.id, reviewSchema.parse({ kind: "informational", worker: second.worker, finding_version: second.finding_version,
      verdict: "pass", reason: "Attribution corrected", severity: "informational", severity_reason: "No target impact" }));

    const current = store.get(id).findings[0];
    assert.equal(current.kind, "informational");
    assert.equal(current.severity, null);
    assert.equal(current.cvss, null, "older score must not survive a passing review without a vector");
    assert.equal(store.get(id).reviews[0].cvss?.score, 6.9, "history stays on the review record");
  } finally { store.close(); }
});
