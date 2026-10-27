import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp } from "../helpers/server.js";
import { createProjectSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { reportFields } from "../fixtures/report.js";
import { cvss } from "../fixtures/cvss.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("operator HTTP actions enforce Review, version and notes; library and reports follow return/retest/delete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tessera-actions-")),
    store = new Store(join(directory, "data.db"));
  const app = buildApp(store, new RuntimeConfig(join(directory, "runtime.json")), join(directory, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Actions", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const proof = store.addEvidence(id, { title: "Proof", content: "raw", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({ ...reportFields, title: "Claim", description: "Details", evidence_ids: [proof.id] }),
    );
    const send = (payload: object) =>
      app.inject({ method: "POST", url: `/api/projects/${id}/findings/${finding.id}/actions`, payload });
    const base = { creator: "operator", reason: "Need fresh proof", expected_version: 1 };
    assert.equal((await send({ ...base, action: "return" })).statusCode, 409);
    const job = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(
      id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: 1,
        verdict: "pass",
        kind: "vulnerability",
        reason: "Checked",
        cvss: cvss.high,
      }),
    );
    assert.equal((await app.inject("/api/findings")).json().length, 1);
    // Operator approval: version-bound, one click, and the finding leaves the pending queue.
    const pendingFinding = store.submitFinding(
      id,
      findingSchema.parse({
        ...reportFields,
        title: "Pending claim",
        description: "Details 2",
        evidence_ids: [proof.id],
      }),
    );
    const approve = (payload: object) =>
      app.inject({ method: "POST", url: `/api/projects/${id}/findings/${pendingFinding.id}/approval`, payload });
    assert.equal((await app.inject("/api/reviews")).json().length, 1);
    assert.equal((await approve({ approved: true, expected_version: 1, creator: "operator" })).statusCode, 200);
    assert.equal(
      (await app.inject("/api/reviews")).json().length,
      0,
      "an approved finding is not pending work any more",
    );
    assert.equal((await approve({ approved: true, expected_version: 99, creator: "operator" })).statusCode, 409);
    assert.equal((await approve({ approved: false, expected_version: 1, creator: "operator" })).statusCode, 200);
    assert.equal((await app.inject("/api/reviews")).json().length, 1, "unapproving restores the pending entry");
    const report = (await app.inject({ method: "POST", url: `/api/projects/${id}/reports`, payload: {} })).json();
    assert.equal((await send({ ...base, action: "return", reason: " " })).statusCode, 422);
    assert.equal((await send({ ...base, action: "return", expected_version: 99 })).statusCode, 409);
    assert.equal((await send({ ...base, action: "return" })).statusCode, 200);
    assert.equal((await app.inject("/api/findings")).json().length, 0);
    assert.equal((await app.inject(`/api/projects/${id}/reports`)).json()[0].stale, true);
    assert.equal((await app.inject(`/api/projects/${id}/reports/${report.id}`)).json().material.findings.length, 1);
    const retest = await send({ ...base, expected_version: 2, action: "retest" });
    assert.equal(retest.statusCode, 200, retest.body);
    assert.ok(retest.json().human_feedback.step_id);
    assert.equal((await send({ ...base, expected_version: 3, action: "delete" })).statusCode, 200);
    assert.ok(store.get(id).findings[0].deleted);
    // Operator undo: deletion stays reversible without minting a new ID or version.
    const restore = (payload: object) =>
      app.inject({ method: "POST", url: `/api/projects/${id}/findings/${finding.id}/restore`, payload });
    assert.equal((await restore({ creator: "operator" })).statusCode, 200);
    assert.equal(store.get(id).findings[0].deleted, undefined);
    assert.equal(store.get(id).findings[0].version, 3);
    assert.equal(store.get(id).findings[0].restored?.deletion.reason, base.reason);
    assert.equal((await restore({ creator: "operator" })).statusCode, 409);
    assert.equal(
      (await app.inject({ method: "POST", url: `/api/projects/${id}/findings/${finding.id}/manual`, payload: {} }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: `/api/projects/${id}/fgs/decide`, payload: {} })).statusCode,
      404,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
