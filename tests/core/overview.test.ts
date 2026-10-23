import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import {
  createProjectSchema,
  findingSchema,
  reviewSchema,
} from "../../packages/protocol/src/index.js";
import type { Job } from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";
import { reviewQueue, reviewSummary } from "../../apps/web/src/review-queue.js";

/** 跨项目总览：计数口径、风险分档、趋势与待处理事项。 */
test("security overview aggregates findings and risk across projects", () => {
  const store = new Store(":memory:");
  try {
    const create = (title: string) =>
      store.create(
        createProjectSchema.parse({
          title,
          origin: `https://${title.replace(/\s+/g, "-").toLowerCase()}.test`,
          goal: "Verify impact",
        }),
      ).project.id;

    // A：一条已审核通过的高危发现
    const alpha = create("Alpha");
    const alphaStep = store.manualStep(alpha, {
      from: ["origin"],
      description: "Verify alpha impact",
      creator: "human",
      claim: true,
    });
    const alphaEvidence = store.addEvidence(alpha, {
      title: "Alpha response",
      content: "observed alpha response",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const alphaFinding = store.submitStepFinding(
      alpha,
      alphaStep.id,
      "human",
      findingSchema.parse({
        ...reportFields, title: "Alpha impact",
        description: "Observed alpha impact",
        evidence_ids: [alphaEvidence.id],
        severity: "high",
        severity_reason: "Initial assessment",
      }),
    );
    store.manualConclude(alpha, alphaStep.id, "human", "Finished observations");
    const job = store.claim(alpha, "reviewer", deferDecideMs)!;    store.review(
      alpha,
      alphaFinding.id,
      reviewSchema.parse({ kind: "vulnerability",
        worker: job.worker,
        finding_version: job.finding_version,
        verdict: "pass",
        reason: "Evidence verified",
        cvss: cvss.high,
      }),
    );

    // B：一条未审核的候选发现
    const beta = create("Beta");
    const betaStep = store.manualStep(beta, {
      from: ["origin"],
      description: "Verify beta impact",
      creator: "human",
      claim: true,
    });
    store.submitStepFinding(
      beta,
      betaStep.id,
      "human",
      findingSchema.parse({
        title: "Beta candidate",
        description: "Unreviewed candidate",
        severity: "medium",
      }),
    );

    // C：没有发现的项目也必须出现在列表里
    const gamma = create("Gamma");

    // 用量：跨项目汇总；输入或输出缺失的字段不计入合计，但请求仍然计数。
    const usageJob = (projectId: string): Job => ({
      kind: "decide",
      project_id: projectId,
      graph_id: "main",
      worker: "usage-planner",
    });
    store.usage(alpha, usageJob(alpha), 1000, 200, null, undefined, "completed", {
      input_uncached: 600,
      cache_read: 400,
      cache_write: 0,
    });
    store.usage(beta, usageJob(beta), null, 50, null);

    const overview = store.overview();
    assert.equal(overview.totals.projects, 3);
    assert.equal(overview.totals.active_projects, 3);
    assert.equal(overview.totals.findings, 2);
    assert.equal(overview.totals.confirmed, 1);
    assert.equal(overview.totals.pending_review, 1);
    assert.equal(overview.totals.severity.high, 1);
    assert.equal(overview.totals.severity.medium, 0);
    assert.equal(overview.totals.evidence, 1);

    const byId = new Map(overview.projects.map((row) => [row.id, row]));
    assert.equal(byId.get(alpha)!.confirmed, 1);
    assert.equal(byId.get(alpha)!.severity.high, 1);
    assert.equal(byId.get(beta)!.pending_review, 1);
    assert.equal(byId.get(beta)!.confirmed, 0);
    assert.equal(byId.get(gamma)!.finding_count, 0);
    assert.ok(byId.get(gamma)!.last_activity_at);

    assert.equal(overview.recent.length, 2);
    assert.equal(overview.priority.length, 1);
    assert.equal(overview.priority[0].project_id, alpha);
    assert.equal(overview.priority[0].severity, "high");
    assert.equal(overview.priority[0].confirmed, true);
    assert.equal(overview.priority[0].asset_hostname, null);

    assert.ok(overview.attention.some((item) => item.project_id === beta && item.kind === "review"));
    assert.equal(overview.trend.length, 14);
    assert.equal(
      overview.trend.reduce((sum, point) => sum + point.created, 0),
      1,
    );
    assert.equal(
      overview.trend.reduce((sum, point) => sum + point.reviewed, 0),
      1,
    );

    assert.equal(overview.usage.trend.length, 14);
    assert.equal(overview.usage.requests, 2);
    assert.equal(overview.usage.unknown, 1);
    assert.equal(overview.usage.input, 1000);
    assert.equal(overview.usage.output, 250);
    assert.equal(overview.usage.cache_read, 400);
    assert.equal(overview.usage.cache_write, 0);
    assert.equal(
      overview.usage.trend.reduce((sum, point) => sum + point.input, 0),
      1000,
    );
    assert.equal(
      overview.usage.trend.reduce((sum, point) => sum + point.output, 0),
      250,
    );
    assert.equal(
      overview.usage.trend.reduce((sum, point) => sum + point.requests, 0),
      2,
    );

    const flat = store.allFindings();
    assert.equal(flat.length, 2);
    assert.equal(flat[0].severity, "high");
    assert.equal(flat[0].project_title, "Alpha");
    assert.equal(flat[1].project_id, beta);
  } finally {
    store.close();
  }
});

test("workspace review counts match project queues and distinguish reviewers from waiting", () => {
  const store = new Store(":memory:");
  try {
    const ids = ["Active queue", "Paused queue"].map(title => store.create(createProjectSchema.parse({ title, origin: "https://example.test", goal: "Verify review counts" })).project.id);
    for (const id of ids) {
      const finding = store.submitFinding(id, findingSchema.parse({ title: "Waiting candidate", description: "Synthetic review item" }));
      store.mutate(id, "fixture.review-queue", false, graph => {
        if (id === ids[1]) { graph.project.status = "stopped"; return; }
        graph.findings.push(
          { ...finding, id: "v_running", title: "Claimed review", review_worker: "reviewer" },
          { ...finding, id: "v_revised", version: 2, reviewed_version: 1, review_status: "rejected" },
          { ...finding, id: "v_done", reviewed_version: finding.version, review_status: "rejected" },
          { ...finding, id: "v_merged", merged_into: finding.id },
          { ...finding, id: "v_withdrawn", withdrawn_at: finding.created_at },
        );
      });
    }
    const overview = store.overview(), findings = store.allFindings();
    assert.equal(overview.totals.pending_review, 4);
    assert.deepEqual(reviewSummary(findings), { total: 4, reviewing: 1, waiting: 3 });
    assert.equal(reviewQueue(findings).length, overview.totals.pending_review);
    assert.equal(findings.find(finding => finding.id === "v_running")?.review_gate, "reviewing");
    assert.equal(findings.find(finding => finding.project_id === ids[1])?.review_gate, "inactive");
    assert.equal(findings.find(finding => finding.id === "v_revised")?.reviewed, false);
    for (const id of ids) {
      const count = pendingReviews(store.get(id)).length;
      assert.equal(overview.projects.find(project => project.id === id)?.pending_review, count);
      assert.equal(reviewQueue(findings).filter(finding => finding.project_id === id).length, count);
      assert.equal(store.list().find(project => project.id === id)?.review_pending_count, count);
    }
  } finally { store.close(); }
});

test("informational findings are confirmed observations, not vulnerabilities", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({
      title: "Attribution",
      origin: "https://10.129.74.228.test",
      goal: "Verify the observed behaviour",
    })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Verify the endpoint", creator: "human", claim: true });
    const evidence = store.addEvidence(id, { title: "Raw response", content: "HTTP/1.1 502 Bad Gateway", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({
      title: "Host forwarding comes from the sandbox egress layer",
      description: "The answering party is infrastructure, not the target",
      evidence_ids: [evidence.id],
      severity: "informational",
      severity_reason: "No impact attributable to the target",
    }));
    store.manualConclude(id, step.id, "human", "Attribution checked");
    const review = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(id, finding.id, reviewSchema.parse({ kind: "informational",
      worker: review.worker,
      finding_version: review.finding_version,
      verdict: "pass",
      reason: "Attribution correction is backed by the original evidence",
      severity: "informational",
      severity_reason: "Not a target vulnerability",
    }));

    const graph = store.get(id);
    assert.equal(graph.findings[0].review_status, "pass");
    assert.equal(graph.findings[0].status, "confirmed");

    const overview = store.overview();
    assert.equal(overview.totals.confirmed, 0, "informational cannot count as a confirmed vulnerability");
    assert.equal(overview.totals.informational, 1);
    assert.equal(overview.totals.severity.informational, 0, "risk distribution excludes non-vulnerabilities");
    assert.equal(overview.totals.findings, 1);
    assert.equal(overview.projects[0].confirmed, 0);
    assert.equal(overview.projects[0].informational, 1);
    assert.equal(overview.priority.length, 0);

    const [flat] = store.allFindings();
    assert.equal(flat.confirmed, false);
    assert.equal(flat.informational, true);
    assert.equal(flat.cvss_score, null);

    const material = reportMaterial(graph);
    assert.equal(material.findings.length, 0, "the report body only carries vulnerabilities");
    assert.equal(material.excluded.informational, 1);
  } finally {
    store.close();
  }
});
