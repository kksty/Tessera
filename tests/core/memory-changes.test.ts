import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, type Event } from "../../packages/protocol/src/index.js";
import { queryChanges } from "../../packages/core/src/memory-changes.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-changes-"));
  const store = new Store(join(dir, "graph.db"));
  const graph = store.create(createProjectSchema.parse({ title: "Changes", origin: "https://example.test", goal: "核对变化" }));
  return { dir, store, id: graph.project.id, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("semantic change pages reach beyond 500 events, deduplicate revisions and exclude routine material", () => {
  const f = fixture();
  try {
    const start = f.store.get(f.id).observation_revision;
    const hint = f.store.hint(f.id, "初始意见");
    for (let i = 0; i < 510; i++) f.store.mutate(f.id, "fact.observed", true, graph => {
      graph.facts.push({ id: `f${i}`, description: `观测 ${i}`, graph_id: "main", evidence_ids: [] });
    });
    f.store.updateHint(f.id, hint.id, { content: "修订后的意见" });
    const through = f.store.get(f.id).observation_revision;
    f.store.addEvidence(f.id, { title: "非语义证据归档", content: "raw", encoding: "utf8", mime_type: "text/plain" });
    f.store.audit(f.id, "report.stale", { facts: [{ id: "fake", description: "审计不进入变化" }] }, through);
    const query = { after_revision: start, through_revision: through, limit: 0 };
    const entry = f.store.memoryChanges(f.id, query);
    assert.equal(entry.total, 511);
    assert.equal(entry.items.length, 0);
    assert.equal("unknown_legacy_events" in entry, false);
    const ids: string[] = [];
    let cursor: string | undefined = entry.next_cursor!;
    // Concurrent semantic events do not enter this pinned interval.
    f.store.hint(f.id, "快照之后的新意见");
    do {
      const page = f.store.memoryChanges(f.id, { ...query, limit: 100, cursor });
      assert.ok(JSON.stringify(page).length <= 8000);
      assert.equal(page.through_seq, entry.through_seq);
      ids.push(...page.items.map(item => item.id));
      if (!page.next_cursor) {
        assert.equal(page.items.at(-1)?.preview, "修订后的意见");
        assert.equal(page.items.at(-1)?.semantic_source, "recorded");
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(ids).size, 511);
    assert.equal(ids.filter(id => id === hint.id).length, 1);
    assert.ok(!ids.includes("fake"));
    assert.throws(() => f.store.memoryChanges(f.id, { ...query, through_revision: through + 1, cursor: entry.next_cursor! }), /cursor/);
    const event = f.store.events(f.id).find(e => e.kind === "hint.added")!;
    const raw = f.store.readMemoryChange(f.id, event.seq, 0, 20);
    assert.equal(raw.content.length, 20);
    assert.equal(raw.next_offset, 20);
    const other = f.store.create(createProjectSchema.parse({ title: "Other", origin: "https://other.test", goal: "Other" }));
    assert.throws(() => f.store.readMemoryChange(other.project.id, event.seq), /Event not found/);
  } finally { f.close(); }
});

test("unmarked historical events are ignored without inferring business semantics", () => {
  const make = (seq: number, kind: string, data: Record<string, unknown>): Event => ({ seq, revision: seq, kind, data,
    project_id: "project", created_at: "" });
  const events = [
    make(1, "fact.observed", { changes: { facts: [{ id: "f1", description: "历史观测" }] } }),
    make(2, "usage.recorded", { changes: { usage: [{ id: "u1" }] } }),
    make(3, "jobs.state", { changes: { steps: [{ id: "i1" }] } }),
    make(4, "finding.reviewed", { changes: { reviews: [{ kind: "vulnerability", id: "r1", verdict: "pass" }] } }),
    make(5, "finding.reviewed", { changes: { reviews: [{ id: "r2", verdict: "needs_evidence", reason: "需要原文" }] } }),
    make(6, "old.unknown", { changes: { facts: [{ id: "f2", description: "无法确认的旧事件" }] } }),
    make(7, "fact.observed", { semantic: false, changes: { facts: [{ id: "f3" }] } }),
  ];
  const result = queryChanges("project", { after_revision: 0, through_revision: 7 }, 7, () => events);
  assert.deepEqual(result.items, []);

});

test("event highwater pins late inserts at old revisions and rejects interval/project cursor reuse", () => {
  const events: Event[] = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, revision: i + 1,
    project_id: "p1", created_at: "", kind: "fact.observed", data: { semantic: true,
      changes: { facts: [{ id: `f${i}`, description: "原始事实" }] } } }));
  const query = { after_revision: 0, through_revision: 10, limit: 1 };
  const first = queryChanges("p1", query, 10, () => events);
  events.push({ ...events[0], seq: 11, data: { semantic: true, changes: { facts: [{ id: "late" }] } } });
  const rest = queryChanges("p1", { ...query, cursor: first.next_cursor!, limit: 100 }, 11, () => events);
  assert.equal(rest.total, 10);
  assert.ok(!rest.items.some(item => item.id === "late"));
  assert.throws(() => queryChanges("p2", { ...query, cursor: first.next_cursor! }, 11, () => events), /cursor/);
  assert.throws(() => queryChanges("p1", { ...query, through_revision: 9, cursor: first.next_cursor! }, 11, () => events), /cursor/);
});

test("changes HTTP endpoints require worker credentials and reject malformed intervals", async () => {
  const f = fixture(), app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json")), join(f.dir, "no-web"));
  const url = `/api/projects/${f.id}/fgs/changes`;
  try {
    const payload = { after_revision: 0, through_revision: 1 };
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 403);
    const headers = { "x-tessera-worker-token": testWorkerToken };
    const response = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().items.some((item: { id: string }) => item.id === "origin"));
    for (const invalid of [{ after_revision: -1, through_revision: 1 }, { after_revision: 2, through_revision: 1 },
      { after_revision: 0, through_revision: 999 }, { ...payload, limit: 101 }]) {
      assert.ok((await app.inject({ method: "POST", url, headers, payload: invalid })).statusCode >= 400);
    }
    assert.equal((await app.inject({ method: "POST", url: `${url}/read`, headers, payload: { event_seq: 999 } })).statusCode, 404);
  } finally { await app.close(); f.close(); }
});
