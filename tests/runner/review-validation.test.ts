import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  findingSchema,
  type DispatchConfig,
  type Job,
} from "../../packages/protocol/src/index.js";
import { repairFinalResult, validateFinalResult } from "../../packages/runner/src/result-validation.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

test("Review semantic failures enter bounded local repair before any submission, without inventing impact", async () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(
      createProjectSchema.parse({ title: "Review contract", origin: "https://example.test", goal: "fixture" }),
    );
    const id = graph.project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "fixture", creator: "human", claim: true });
    const evidence = store.addEvidence(id, {
      title: "Original",
      content: "raw proof",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const finding = store.submitStepFinding(
      id,
      step.id,
      "human",
      findingSchema.parse({ ...reportFields, title: "Impact", description: "Observed", evidence_ids: [evidence.id] }),
    );
    const job = {
      kind: "review",
      worker: "reviewer",
      graph_id: "main",
      project_id: id,
      finding_id: finding.id,
      finding_version: 1,
    } as Job;
    const initial = {
      kind: "vulnerability",
      verdict: "pass",
      reason: "Evidence reviewed",
      cvss: { vector: cvss.low.vector, rationale: "Observed" },
    };
    let text = JSON.stringify(initial),
      repairs = 0;
    const config = { result_repairs: 1 } as DispatchConfig;
    const validate = (text: string | undefined) =>
      validateFinalResult(job, store.get(id), async () => store.get(id), text);
    const payload = await repairFinalResult({
      job,
      config,
      deadline: Infinity,
      key: "",
      text: () => text,
      stopReason: () => "stop",
      leaseError: () => undefined,
      trace: () => {},
      diagnose: () => {},
      validate,
      repair: async (detail) => {
        assert.match(detail, /impact_evidence/);
        repairs++;
        text = JSON.stringify({ verdict: "needs_evidence", kind: "vulnerability", reason: "实际影响尚无原始证明" });
      },
    });
    assert.equal(payload.verdict, "needs_evidence");
    assert.equal(repairs, 1);
    for (const bad of [
      { ...initial, cvss: null },
      { verdict: "needs_evidence", reason: "partial", severity: "high" },
    ])
      await assert.rejects(validate(JSON.stringify(bad)));
    text = JSON.stringify(initial);
    repairs = 0;
    await assert.rejects(
      repairFinalResult({
        job,
        config,
        deadline: Infinity,
        key: "",
        text: () => text,
        stopReason: () => "stop",
        leaseError: () => undefined,
        trace: () => {},
        diagnose: () => {},
        validate,
        repair: async () => {
          repairs++;
        },
      }),
      /final JSON does not match/,
    );
    assert.equal(repairs, 1);
  } finally {
    store.close();
  }
});
