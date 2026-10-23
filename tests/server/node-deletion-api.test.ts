import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { createProjectSchema, executeSchema } from "../../packages/protocol/src/index.js";
import { projectToken } from "../../packages/protocol/src/internal-auth.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("HTTP deletion preserves receipts, defaults to the active graph and gates explicit raw history by project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-node-deletion-api-")), store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "Deletion API", origin: "https://example.test", goal: "Assess" })).project.id;
  const other = store.create(createProjectSchema.parse({ title: "Other project", origin: "https://other.test", goal: "Assess" })).project.id;
  const source = store.manualStep(id, { from: ["origin"], description: "Source", creator: "human", claim: true });
  const evidence = store.addEvidence(id, { title: "Archived", content: "irreversible original bytes", mime_type: "text/plain", encoding: "utf8" });
  const fact = store.fact(id, source.id, { worker: "human", description: "REMOVED_HTTP_BODY_" + "原文".repeat(5000), evidence_ids: [evidence.id] });
  store.execute(id, source.id, executeSchema.parse({ worker: "human", summary: "REMOVED_HTTP_BODY_summary" }));
  store.closeStep(id, source.id, { worker: "human", reason: "Done" });
  const live = store.manualStep(id, { from: [fact.id], description: "Live consumer", creator: "human" });
  const execution = store.claim(id, "executor", deferDecideMs)!;
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  const headers = { "x-tessera-project-token": projectToken(testWorkerToken, id) };
  const post = (suffix: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/projects/${id}${suffix}`, headers, payload });
  try {
    const accepted = await post(`/fgs/steps/${live.id}/facts`, { worker: execution.worker, run_id: execution.run_id,
      submission_id: "streamed", description: "Accepted before deletion" });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const job = store.claim(id, "decider", 0)!, graph = store.get(id);
    const body = { submission_id: "deletion", run_id: job.run_id, worker: job.worker, revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision, delete_nodes: [{ id: fact.id, reason: "Prune this source" }, { id: live.id, reason: "Stop this task" }] };
    const beforePreview = JSON.stringify(store.get(id)), events = store.events(id).length;
    const preview = await post("/fgs/deletions/preview", { delete_nodes: body.delete_nodes });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().valid, true);
    assert.deepEqual(preview.json().deleted, [fact.id, live.id].sort());
    assert.deepEqual(preview.json().cancelled_runs, [execution.run_id]);
    assert.equal(JSON.stringify(store.get(id)), beforePreview);
    assert.equal(store.events(id).length, events);
    assert.equal((await post("/fgs/deletions/preview", { delete_nodes: [] })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${other}/fgs/deletions/preview`, headers,
      payload: { delete_nodes: body.delete_nodes } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${id}/fgs/deletions/preview`,
      payload: { delete_nodes: body.delete_nodes } })).statusCode, 403);
    const submission = { ...body, deletion_preview_hash: preview.json().impact_hash };
    const deleted = await post("/fgs/decisions", submission);
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().settle.ok, true, deleted.body);
    assert.deepEqual(deleted.json().settle.deleted, [fact.id, live.id].sort());
    const active = await app.inject({ url: `/api/projects/${id}/fgs`, headers });
    assert.equal(active.statusCode, 200);
    assert.ok(!active.body.includes("REMOVED_HTTP_BODY"));
    assert.ok(active.json().deleted_nodes.some((ref: { id: string }) => ref.id === fact.id));
    const history = await app.inject({ url: `/api/projects/${id}/fgs/history/${fact.id}?limit=1000`, headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.ok(history.json().content.includes("REMOVED_HTTP_BODY"));
    assert.equal(history.json().deletion.submission_id, "deletion");
    const next = await app.inject({ url: `/api/projects/${id}/fgs/history/${fact.id}?offset=1000&limit=1000&expected_hash=${history.json().record_hash}`, headers });
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().offset, 1000);
    assert.equal((await app.inject({ url: `/api/projects/${other}/fgs/history/origin`, headers })).statusCode, 403);
    assert.equal((await app.inject({ url: `/api/projects/${id}/fgs/history/${fact.id}` })).statusCode, 403);
    assert.equal((await app.inject({ url: `/api/projects/${id}/fgs?history=invalid`, headers })).statusCode, 422);
    const replay = await post("/fgs/decisions", submission);
    assert.deepEqual(replay.json(), deleted.json());
    const replayFact = await post(`/fgs/steps/${live.id}/facts`, { worker: execution.worker, run_id: execution.run_id,
      submission_id: "streamed", description: "Accepted before deletion" });
    assert.deepEqual(replayFact.json(), accepted.json());
    const late = await post(`/fgs/steps/${live.id}/facts`, { worker: execution.worker, run_id: execution.run_id,
      submission_id: "late", description: "Cannot resurrect deleted task" });
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(store.execution.get(id, execution.run_id!)!.status, "cancelled");
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
