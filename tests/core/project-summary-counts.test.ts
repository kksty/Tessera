import { recordReview } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

/** 项目列表必须区分「全部发现」与「已确认漏洞」，否则会把候选当成漏洞计数。 */
test("project summaries separate confirmed vulnerabilities from all findings", () => {
  const store = new Store(":memory:");
  try {
    const project = store.create(
      createProjectSchema.parse({
        title: "Count contract",
        origin: "https://count.test",
        goal: "Verify counters",

      }),
    ).project.id;
    const step = store.manualStep(project, {
      from: ["origin"],
      description: "Collect evidence",
      creator: "human",
      claim: true,
    });
    const evidence = store.addEvidence(project, {
      title: "Original response",
      content: "HTTP/1.1 200 OK",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const finding = store.submitStepFinding(
      project,
      step.id,
      "human",
      findingSchema.parse({
        ...reportFields,
        title: "Confirmed issue",
        description: "Confirmed impact",
        evidence_ids: [evidence.id],
        severity: "high",
        severity_reason: "Initial assessment",
        cvss: cvss.high,
      }),
    );
    recordReview(store, project, finding.id, "confirmed", "human", "Checked", "vulnerability");
    store.submitStepFinding(
      project,
      step.id,
      "human",
      findingSchema.parse({
        title: "Candidate issue",
        description: "Still a candidate",
        severity: "medium",
      }),
    );
    // Withdrawn records stay in history but must not inflate the counters.
    store.mutate(project, "", false, (graph) => {
      const candidate = graph.findings.find((item) => item.title === "Candidate issue")!;
      candidate.withdrawn_at = new Date().toISOString();
    });
    const active = store.submitFinding(project, {
      title: "Another candidate",
      description: "Still waiting for review",
      severity: "low",
      from: ["origin"],
    });
    void active;

    const summary = store.list()[0];
    assert.equal(summary.finding_count, 2, "all active findings incl. candidates");
    assert.equal(summary.confirmed_finding_count, 1, "only reviewed vulnerabilities");
    assert.equal(summary.informational_finding_count, 0);
    assert.equal(store.overview().totals.confirmed, 1);
  } finally {
    store.close();
  }
});
