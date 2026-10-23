import { commitPlan } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, bookmarkInputSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { memoryEntry, queryMemory, readMemoryRecord } from "../../packages/core/src/memory.js";
import { admitCloseoutTool } from "../../packages/runner/src/closeout.js";
import { SubmissionOutbox, replaySubmission } from "../../packages/runner/src/submissions.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { replay } from "../../apps/web/src/replay.js";
import { projectActivity } from "../../apps/web/src/project-activity.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-bookmarks-")), file = join(dir, "graph.db"), store = new Store(file);
  const graph = store.create(createProjectSchema.parse({ title: "Bookmarks", origin: "https://example.test", goal: "查找原始条件" }));
  const id = graph.project.id, job = store.claim(id, "planner", 0)!;
  const input = (node_id = "origin", expected_version = 0) => bookmarkInputSchema.parse({ worker: job.worker, node_id,
    expected_version, reason: "相关条件需要回访", revisit_when: "访问条件发生变化时" });
  return { dir, file, store, id, job, input, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("bookmarks survive restart, retain audited versions and never become observations or scheduling changes", () => {
  const f = fixture();
  let closed = false;
  try {
    const before = f.store.get(f.id), b = f.store.bookmark(f.id, f.job.run_id!, f.input());
    assert.equal(b.updated_by, f.job.worker); assert.equal(b.run_id, f.job.run_id); assert.equal(b.version, 1);
    const after = f.store.get(f.id);
    assert.equal(after.observation_revision, before.observation_revision);
    assert.deepEqual(after.facts, before.facts); assert.deepEqual(after.steps, before.steps); assert.deepEqual(after.assets, before.assets);
    assert.equal(f.store.events(f.id).at(-1)!.data.semantic, false);
    assert.equal(queryMemory(after, { kind: "bookmarks", status: "active" }).items[0].node_id, "origin");
    assert.equal(queryMemory(after, { related_to: b.id, relation: "sources" }).items[0].id, "origin");
    assert.throws(() => commitPlan(f.store, f.id, decideSchema.parse({ worker: f.job.worker, revision: after.revision,
      observation_revision: after.observation_revision, planning_revision: after.planning_revision, steps: [{ from: [b.id], description: "不能从书签证明事实" }] })), /Invalid source fact/);
    assert.equal(f.store.memoryChanges(f.id, { after_revision: before.observation_revision, through_revision: after.revision }).total, 0);
    f.store.close(); closed = true;
    const reopened = new Store(f.file);
    try { assert.deepEqual(reopened.get(f.id).bookmarks, after.bookmarks); } finally { reopened.close(); }
  } finally { if (!closed) f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("withdrawal, reactivation and concurrent updates preserve current state and all historical search", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture", false, g => {
      for (let i = 0; i < 220; i++) g.facts.push({ id: `f-old-${i}`, description: `旧图观测 ${i}`, graph_id: "old", evidence_ids: [] });
    });
    const first = f.store.bookmark(f.id, f.job.run_id!, f.input("f-old-219"));
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, f.input("f-old-219")), /Bookmark changed/);
    f.store.bookmark(f.id, f.job.run_id!, bookmarkInputSchema.parse({ worker: f.job.worker, node_id: first.node_id, expected_version: 1, withdraw: true }));
    let graph = f.store.get(f.id);
    assert.equal(queryMemory(graph, { kind: "bookmarks", status: "active" }).total, 0);
    assert.equal(queryMemory(graph, { kind: "bookmarks", status: "withdrawn" }).items[0].version, 2);
    assert.equal(queryMemory(graph, { keyword: "旧图观测 219", kind: "facts" }).items[0].id, first.node_id);
    assert.ok(readMemoryRecord(graph, first.node_id).content?.includes("旧图观测 219"));
    f.store.bookmark(f.id, f.job.run_id!, f.input(first.node_id, 2));
    graph = f.store.get(f.id);
    assert.equal(graph.bookmarks![0].withdrawn_at, undefined);
    assert.equal(queryMemory(graph, { kind: "bookmarks", status: "active" }).items[0].version, 3);
    const events = f.store.events(f.id).filter(e => e.kind === "bookmark.updated");
    assert.equal(events.length, 3);
    assert.equal((events[0].data.changes as any).bookmarks[0].version, 1);
    const allEvents = f.store.events(f.id);
    assert.equal(replay(allEvents, allEvents.length - 1)!.bookmarks![0].version, 3);
    assert.ok(!projectActivity(allEvents, graph).some(r => r.kind === "bookmark.updated"));
    const rows = projectActivity(allEvents, graph, true).filter(r => r.kind === "bookmark.updated");
    assert.equal(rows.length, 3); assert.equal(rows[0].actor, f.job.worker); assert.equal(rows[0].title, "更新回访书签");
  } finally { f.close(); }
});

test("legacy graphs and large bookmark indexes are counted in the full entry and paginated by query", () => {
  const f = fixture();
  try {
    const graph = f.store.get(f.id);
    assert.equal(memoryEntry(graph, f.job).counts.bookmarks, 0);
    const original = f.store.bookmark(f.id, f.job.run_id!, f.input());
    graph.bookmarks = Array.from({ length: 220 }, (_, i) => ({ ...original, id: `bookmark-${i}`, reason: "关注理由".repeat(250) }));
    const entry = memoryEntry(graph, f.job);
    assert.equal(entry.counts.bookmarks, 220);
    let cursor: string | undefined, count = 0;
    do {
      const page = queryMemory(graph, { kind: "bookmarks", cursor });
      count += page.items.length;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(count, 220);
  } finally { f.close(); }
});

test("bookmark writes require existing local nodes, active identity and live lease", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, f.input("absent")), /existing project node/);
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, { ...f.input(), worker: "other" }), /active Run/);
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, { ...f.input(), reason: "" }));
    f.store.mutate(f.id, "", false, g => { g.project.reason!.last_heartbeat_at = "2000-01-01T00:00:00Z"; });
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, f.input()), /expired/);
    assert.equal(f.store.get(f.id).bookmarks, undefined);
    f.store.release(f.id, f.job);
    assert.throws(() => f.store.bookmark(f.id, f.job.run_id!, f.input()), /active Run/);
  } finally { f.close(); }
});

test("all three Job roles may maintain navigation without obtaining observation or execution permission", () => {
  const f = fixture();
  try {
    const snapshot = f.store.get(f.id);
    commitPlan(f.store, f.id, decideSchema.parse({ worker: f.job.worker, revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision,
      steps: [{ from: ["origin"], description: "核对" }] }));
    const execute = f.store.claim(f.id, "executor", 0)!;
    assert.equal(execute.kind, "execute");
    f.store.bookmark(f.id, execute.run_id!, { ...f.input(), worker: execute.worker });
    f.store.submitFinding(f.id, { title: "候选发现", description: "仅为原始依据导航测试" });
    const review = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(review.kind, "review");
    f.store.bookmark(f.id, review.run_id!, { ...f.input("goal"), worker: review.worker });
    const after = f.store.get(f.id);
    assert.equal(after.findings[0].review_status, "pending");
    assert.equal(after.steps[0].concluded_at, null);
    assert.equal(f.store.runs(f.id).find(r => r.id === review.run_id)!.external_action_possible, false);
  } finally { f.close(); }
});

test("bookmark API requires worker/run/key, persists outbox and replays accepted writes after lease ends", async () => {
  const f = fixture(), app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json")), join(f.dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const url = `/api/projects/${f.id}/fgs/bookmarks`;
    assert.equal((await app.inject({ method: "POST", url, payload: f.input() })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers: { "x-tessera-worker-token": testWorkerToken }, payload: f.input() })).statusCode, 422);
    const client = new ApiClient(app.listeningOrigin, testWorkerToken), outbox = new SubmissionOutbox(f.dir, f.job, client);
    const path = await outbox.prepare(client.projectPath(f.job, "/fgs/bookmarks"), f.input());
    const saved = await replaySubmission(path, client);
    f.store.release(f.id, f.job);
    assert.deepEqual(await replaySubmission(path, client), saved);
    assert.equal(f.store.get(f.id).bookmarks![0].version, 1);
    assert.equal(f.store.events(f.id).filter(e => e.kind === "bookmark.updated").length, 1);
    for (const readonly of [false, true]) {
      for (const name of ["mark_node", "bash", "query_references", "read_reference"])
        assert.match(admitCloseoutTool(name, {}, readonly)!, /Closeout permits/);
      assert.equal(admitCloseoutTool("read_graph", { id: "origin" }, readonly), undefined);
    }
  } finally { await app.close(); f.close(); }
});
