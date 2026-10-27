import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import {
  createProjectSchema,
  findingSchema,
  reviewSchema,
  submitDecisionsSchema,
  findingKind,
  confirmedVulnerability,
  confirmedInformational,
  classificationReviewRequired,
} from "../../packages/protocol/src/index.js";
import { scoreCvss } from "../../packages/core/src/cvss.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";
import { confirmedVulnerability as browserConfirmed } from "../../apps/web/src/project-activity.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture(file = ":memory:") {
  const store = new Store(file);
  const id = store.create(
    createProjectSchema.parse({ title: "Classification", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "Raw response",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      title: "Independent conclusion",
      description: "Supported conclusion",
      from: ["origin"],
      evidence_ids: [evidence.id],
      identity: { category: "exposure", host: "example.test", path: "/" },
    }),
  );
  const review = (body: Record<string, unknown>) => {
    const job = store.claim(id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
    return store.review(
      id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "pass",
        reason: "Original material checked",
        ...body,
      }),
    );
  };
  return { store, id, evidence, finding, review };
}

test("information can pass with no vulnerability impact or rating and is preserved outside risk and reports", () => {
  const f = fixture();
  try {
    const before = f.store.get(f.id);
    const review = f.review({ kind: "informational" });
    const graph = f.store.get(f.id),
      finding = graph.findings[0];
    assert.equal(review.kind, "informational");
    assert.equal(finding.severity, null);
    assert.equal(finding.cvss, null);
    assert.equal(confirmedInformational(finding, graph), true);
    assert.equal(confirmedVulnerability(finding, graph), false);
    assert.deepEqual(graph.facts, before.facts);
    assert.equal(f.store.overview().totals.informational, 1);
    assert.equal(f.store.overview().totals.confirmed, 0);
    assert.equal(reportMaterial(graph).excluded.informational, 1);
    assert.equal(reportMaterial(graph).findings.length, 0);
    assert.equal(f.store.allFindings()[0].kind, "informational");
  } finally {
    f.store.close();
  }
});

test("passing classification is explicit; vulnerability needs positive scored and bound impact proof", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.report", false, (graph) =>
      Object.assign(graph.findings[0], structuredClone(reportFields)),
    );
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    const submit = (body: Record<string, unknown>) =>
      f.store.review(
        f.id,
        f.finding.id,
        reviewSchema.parse({
          worker: job.worker,
          finding_version: 1,
          verdict: "pass",
          reason: "Checked",
          ...body,
        }),
      );
    for (const kind of [undefined, null]) assert.throws(() => submit({ kind, cvss: cvss.high }), /explicit kind/);
    assert.throws(() => submit({ severity: "informational", severity_reason: "No impact" }), /explicit kind/);
    assert.throws(() => submit({ kind: "vulnerability" }), /requires a CVSS/);
    assert.throws(() => submit({ kind: "vulnerability", cvss: cvss.none }), /positive score/);
    assert.throws(
      () => submit({ kind: "vulnerability", cvss: { vector: cvss.high.vector, rationale: "Missing proof" } }),
      /impact_evidence/,
    );
    assert.throws(() => submit({ kind: "informational", cvss: cvss.none }), /no severity or CVSS/);
    assert.equal(f.store.get(f.id).reviews.length, 0, "failed validation has no partial changes");
    submit({ kind: "vulnerability", cvss: cvss.high });
    const current = f.store.get(f.id),
      finding = current.findings[0];
    assert.equal(confirmedVulnerability(finding, current), true);
    assert.equal(browserConfirmed(finding, current), true);
    assert.equal(f.store.overview().totals.confirmed, 1);
    assert.equal(reportMaterial(current).findings.length, 1);
    assert.equal(confirmedVulnerability({ ...finding, kind: null }, current), false);
    assert.equal(confirmedVulnerability({ ...finding, cvss: { ...finding.cvss!, score: 10 } }, current), false);
    assert.equal(confirmedVulnerability(finding, { evidence: [] }), false);
    assert.equal(confirmedVulnerability({ ...finding, merged_into: "v999" }, current), false);
    assert.equal(confirmedVulnerability({ ...finding, withdrawn_at: "now" }, current), false);
  } finally {
    f.store.close();
  }
});

test("withdrawn identity never swallows new evidence; explicit same-ID restore creates a new review version", () => {
  const f = fixture();
  try {
    f.review({ kind: "informational" });
    const settle = (submission_id: string, changes: Record<string, unknown>) => {
      const job = f.store.claim(f.id, "planner", 0)!;
      const graph = f.store.get(f.id);
      return f.store.submitDecisions(
        f.id,
        submitDecisionsSchema.parse({
          worker: job.worker,
          submission_id,
          revision: graph.revision,
          observation_revision: graph.observation_revision,
          planning_revision: graph.planning_revision,
          ...changes,
        }),
        job.run_id,
      );
    };
    assert.equal(
      settle("withdraw", {
        finding_updates: [{ id: f.finding.id, expected_version: 1, reason: "Outdated scope", withdraw: true }],
      }).settle.ok,
      true,
    );
    const step = f.store.manualStep(f.id, {
      from: ["origin"],
      description: "New support",
      creator: "human",
      claim: true,
    });
    // Same-step incremental identity must fail explicitly rather than quietly return the withdrawn record.
    f.store.mutate(f.id, "fixture", false, (g) => {
      g.findings[0].step_id = step.id;
    });
    assert.throws(
      () =>
        f.store.submitStepFinding(
          f.id,
          step.id,
          "human",
          findingSchema.parse({ title: f.finding.title, description: "New support", identity: f.finding.identity }),
        ),
      /restore:true/,
    );
    f.store.manualConclude(f.id, step.id, "human", "Support saved");
    const restored = settle("restore", {
      finding_updates: [
        {
          id: f.finding.id,
          expected_version: 2,
          reason: "New relevant scope",
          restore: true,
          changes: { description: "Updated applicable scope", kind: "informational" },
        },
      ],
    });
    assert.equal(restored.settle.ok, true);
    const graph = f.store.get(f.id),
      current = graph.findings[0];
    assert.equal(current.id, "v001");
    assert.equal(current.version, 3);
    assert.equal(current.withdrawn_at, undefined);
    assert.equal(current.review_status, "pending");
    assert.equal(graph.reviews.length, 1);
    assert.equal(current.edits?.length, 1);
    assert.equal(confirmedInformational(current, graph), false);
    f.review({ kind: "informational" });
    assert.equal(confirmedInformational(f.store.get(f.id).findings[0], f.store.get(f.id)), true);
  } finally {
    f.store.close();
  }
});
