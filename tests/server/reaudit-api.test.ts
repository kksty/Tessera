import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp } from "../helpers/server.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { classificationReviewRequired } from "../../packages/protocol/src/finding-policy.js";

test("POST /projects/:id/reaudit opens a review-only window for a completed project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-reaudit-api-")),
    store = new Store(join(dir, "graph.db"));
  const runtime = new RuntimeConfig(join(dir, "runtime.json"), {});
  runtime.update({ model: { id: "fixture", base_url: "http://fixture.invalid/v1" } });
  const id = store.create(
    createProjectSchema.parse({ title: "Reaudit API", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "Proof",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  store.submitFinding(
    id,
    findingSchema.parse({ title: "Historical", description: "Old pass", evidence_ids: [evidence.id] }),
  );
  store.mutate(id, "fixture.legacy", false, (graph) => {
    const finding = graph.findings[0];
    delete finding.kind;
    finding.review_status = "pass";
    finding.reviewed_version = finding.version;
    finding.status = "confirmed";
    graph.project.status = "completed";
    graph.goals.find((goal) => goal.id === "goal")!.state = "satisfied";
  });
  assert.equal(classificationReviewRequired(store.get(id).findings[0], store.get(id)), true);
  const app = buildApp(store, runtime, join(dir, "no-web"));
  try {
    const response = await app.inject({ method: "POST", url: `/api/projects/${id}/reaudit` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { count: 1, resumed: true });
    const graph = store.get(id);
    assert.equal(graph.project.status, "active");
    assert.equal(graph.project.reaudit?.restore_status, "completed");
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
