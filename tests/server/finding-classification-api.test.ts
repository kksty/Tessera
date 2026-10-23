import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("HTTP discovery export retains information; library, vulnerability export, totals and reports agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-kind-api-")), store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "Classification API", origin: "https://example.test", goal: "Assess" })).project.id;
  const proof = store.addEvidence(id, { title: "Original proof", content: "response", mime_type: "text/plain", encoding: "utf8" });
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    for (const kind of ["vulnerability", "informational"] as const) {
      const finding = store.submitFinding(id, findingSchema.parse({ ...(kind === "vulnerability" ? reportFields : {}), title: kind, description: "Supported conclusion", evidence_ids: [proof.id] }));
      const job = store.claim(id, `review-${kind}`, deferDecideMs)!;
      const result = await app.inject({ method: "POST", url: `/api/projects/${id}/findings/${finding.id}/review`,
        headers: { "x-tessera-worker-token": testWorkerToken }, payload: { run_id: job.run_id, submission_id: kind,
          worker: job.worker, finding_version: 1, verdict: "pass", kind, reason: "Original material inspected",
          ...(kind === "vulnerability" ? { cvss: cvss.high } : {}) } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal((await app.inject({ method: "POST", url: `/api/projects/${id}/findings/${finding.id}/review`,
        headers: { "x-tessera-worker-token": testWorkerToken }, payload: { run_id: job.run_id, submission_id: kind,
          worker: job.worker, finding_version: 1, verdict: "pass", kind, reason: "Original material inspected",
          ...(kind === "vulnerability" ? { cvss: cvss.high } : {}) } })).statusCode, 200, "accepted receipts replay after lease release");
    }
    store.submitFinding(id, findingSchema.parse({ title: "Candidate", description: "Unreviewed", evidence_ids: [proof.id] }));
    const library = (await app.inject(`/api/findings`)).json();
    assert.deepEqual(library.map((f: any) => f.id), ["v001"]);
    const discovery = (await app.inject(`/api/projects/${id}/export?format=findings`)).json();
    assert.deepEqual(discovery.map((f: any) => f.kind), ["vulnerability", "informational", null]);
    assert.equal(discovery[1].severity, null); assert.equal(discovery[1].cvss, null);
    const exported = (await app.inject(`/api/projects/${id}/export?format=vulnerabilities`)).json();
    assert.deepEqual(exported.map((f: any) => f.id), library.map((f: any) => f.id));
    const report = await app.inject({ method: "POST", url: `/api/projects/${id}/reports`, payload: {} });
    assert.equal(report.statusCode, 200, report.body);
    assert.deepEqual(report.json().material.findings.map((f: any) => f.id), library.map((f: any) => f.id));
    assert.equal(store.overview().totals.confirmed, 1);
    assert.equal(store.overview().totals.informational, 1);
    const revised = await app.inject({ method: "PUT", url: `/api/projects/${id}/findings/v001/details`,
      payload: { expected_version: 1, kind: "informational", description: "Corrected attribution" } });
    assert.equal(revised.statusCode, 200, revised.body);
    assert.deepEqual((await app.inject(`/api/findings`)).json(), []);
    assert.equal(store.get(id).reviews[0].kind, "vulnerability", "old review classification is immutable history");
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
