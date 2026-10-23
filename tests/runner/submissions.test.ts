import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { SubmissionOutbox, loadSubmission, replaySubmission } from "../../packages/runner/src/submissions.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-outbox-")), database = join(dir, "graph.db");
  let store = new Store(database);
  const graph = store.create(createProjectSchema.parse({ title: "Outbox", origin: "https://example.test", goal: "可靠提交" }));
  const planner = store.claim(graph.project.id, "planner", 0)!, snapshot = store.get(graph.project.id);
  commitPlan(store, graph.project.id, decideSchema.parse({ worker: planner.worker, revision: snapshot.revision,
    observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision, steps: [{ from: ["origin"], description: "保存观察" }] }));
  const job = store.claim(graph.project.id, "executor", 0)!;
  return { dir, database, job, get store() { return store; },
    restart() { store.close(); store = new Store(database); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("lost final responses and process restart replay the original key/body after the lease ended", async () => {
  const f = fixture(), runtime = new RuntimeConfig(join(f.dir, "runtime.json"));
  let app = buildApp(f.store, runtime, join(f.dir, "no-web"));
  let calls = 0;
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.endsWith("/execute")) { calls++; reply.raw.destroy(); }
    return payload;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ApiClient(app.listeningOrigin, testWorkerToken);
  const outbox = new SubmissionOutbox(f.dir, f.job, client);
  const operation = client.projectPath(f.job, `/fgs/steps/${f.job.step_id}/execute`);
  const file = await outbox.prepare(operation, { worker: f.job.worker,
    facts: [{ description: "仅一次持久观测", evidence_ids: [] }], findings: [], summary: "完成" }, true);
  try {
    const before = await loadSubmission(join(f.dir, "pending-result.json"));
    assert.equal(before.record.state, "pending");
    assert.equal(before.record.job.run_id, f.job.run_id);
    await assert.rejects(replaySubmission(file, client));
    assert.equal(calls, 3);
    assert.equal((await loadSubmission(file)).record.state, "pending");
    assert.equal(f.store.runs(f.job.project_id)[0].status, "succeeded");
    assert.equal(f.store.get(f.job.project_id).steps[0].fact_ids.length, 1);
    await app.close();
    f.restart();
    app = buildApp(f.store, runtime, join(f.dir, "no-web"));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const recovered = new ApiClient(app.listeningOrigin, testWorkerToken);
    await replaySubmission(join(f.dir, "pending-result.json"), recovered);
    await replaySubmission(file, recovered);
    const after = await loadSubmission(file);
    assert.equal(after.record.state, "accepted");
    assert.equal(after.record.submission_id, before.record.submission_id);
    assert.deepEqual(after.record.payload, before.record.payload);
    assert.equal(f.store.get(f.job.project_id).steps[0].fact_ids.length, 1);
  } finally { await app.close(); f.close(); }
});

test("unaccepted old-run submissions fail once and cannot use a newer lease to resume exploration", async () => {
  const f = fixture(), app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json")), join(f.dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ApiClient(app.listeningOrigin, testWorkerToken), outbox = new SubmissionOutbox(f.dir, f.job, client);
  let calls = 0;
  const originalRequest = client.request.bind(client);
  client.request = async (...args) => { calls++; return originalRequest(...args); };
  try {
    const file = await outbox.prepare(client.projectPath(f.job, `/fgs/steps/${f.job.step_id}/facts`),
      { worker: f.job.worker, description: "过期结果", evidence_ids: [] });
    f.store.release(f.job.project_id, f.job);
    const next = f.store.claim(f.job.project_id, f.job.worker, 0)!;
    assert.notEqual(next.run_id, f.job.run_id);
    await assert.rejects(replaySubmission(file, client));
    assert.equal(calls, 1);
    assert.equal((await loadSubmission(file)).record.state, "rejected");
    await assert.rejects(replaySubmission(file, client), /semantically rejected/);
    assert.equal(calls, 1);
    assert.equal(f.store.get(f.job.project_id).steps[0].run_id, next.run_id);
    assert.equal(f.store.get(f.job.project_id).steps[0].fact_ids.length, 0);
  } finally { await app.close(); f.close(); }
});

test("saved payload is frozen before sending and corrupt or mismatched records never reach the network", async () => {
  const f = fixture();
  const client = new ApiClient("http://unused.test");
  let calls = 0;
  client.commit = async () => { calls++; throw new Error("must not send"); };
  const outbox = new SubmissionOutbox(f.dir, f.job, client);
  try {
    const payload = { worker: f.job.worker, description: "原文", evidence_ids: [] as string[] };
    const file = await outbox.prepare(client.projectPath(f.job, `/fgs/steps/${f.job.step_id}/facts`), payload);
    payload.description = "发送前外部对象发生变化";
    assert.equal((await loadSubmission(file)).record.payload.description, "原文");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.payload.description = "磁盘内容损坏";
    writeFileSync(file, JSON.stringify(saved));
    await assert.rejects(replaySubmission(file, client), /hash mismatch/);
    assert.equal(calls, 0);
    await assert.rejects(outbox.prepare(`/projects/another/fgs/steps/${f.job.step_id}/facts`, payload), /Job\/operation/);
    await assert.rejects(outbox.prepare(client.projectPath(f.job, `/fgs/steps/${f.job.step_id}/facts`), { ...payload, run_id: "different" }), /Job\/operation/);
  } finally { f.close(); }
});
