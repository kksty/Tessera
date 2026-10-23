import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import { DiagnosticRecords } from "../../packages/core/src/diagnostics.js";
import { retentionPolicy } from "../../packages/core/src/retention.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("normalized persistence updates only the header on heartbeat and survives restart/legacy migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-records-")),
    file = join(dir, "graph.db");
  let store = new Store(file);
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Records", origin: "https://example.test", goal: "fixture" }),
    ).project.id;
    store.addEvidence(id, { title: "Raw", content: "unchanged", encoding: "utf8", mime_type: "text/plain" });
    const legacy = store.get(id);
    store.db.prepare("UPDATE platform_projects SET data=? WHERE id=?").run(JSON.stringify(legacy), id);
    store.status(id, "stopped");
    const wire = JSON.parse(String(store.db.prepare("SELECT data FROM platform_projects WHERE id=?").get(id)!.data));
    assert.equal(wire.storage_version, 1);
    assert.equal(wire.evidence, undefined);
    const before = store.get(id);
    store.db.exec(
      "CREATE TEMP TRIGGER forbid_record_rewrite BEFORE UPDATE ON platform_graph_records BEGIN SELECT RAISE(ABORT,'unchanged graph record rewritten'); END",
    );
    store.mutate(id, "", false, (graph) => {
      graph.project.title = "Renamed";
    });
    assert.deepEqual(store.get(id).evidence, before.evidence);
    store.close();
    store = new Store(file);
    assert.equal(store.get(id).project.title, "Renamed");
    assert.deepEqual(store.get(id).evidence, before.evidence);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention compresses old history/diagnostics/evidence without breaking retrieval, deduplication or search rebuild", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-retention-"));
  const store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Archive", origin: "https://example.test", goal: "fixture" }),
    ).project.id;
    const proof = store.addEvidence(id, {
      title: "Original",
      content: "unmistakable raw evidence",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const job = store.claim(id, "worker", 0)!;
    const diagnostics = new DiagnosticRecords(store.db),
      event = { id: randomUUID(), at: new Date().toISOString(), type: "run_end" as const, data: {} };
    diagnostics.save(id, job.run_id!, event);
    store.status(id, "stopped");
    const events = store.events(id),
      through = diagnostics.highwater(id);
    const result = store.retention.archive(
      { events_days: 1, diagnostics_days: 1, evidence_days: 1, batch: 1000 },
      Date.now() + 2 * 86400000,
    );
    assert.ok(result.events > 0);
    assert.equal(result.diagnostics, 1);
    assert.equal(result.evidence, 1);
    assert.equal(existsSync(join(store.evidenceRoot, id, proof.id)), false);
    assert.equal(store.evidenceContent(id, proof.id).bytes.toString(), "unmistakable raw evidence");
    assert.deepEqual(store.events(id), events);
    assert.equal(diagnostics.highwater(id), through);
    diagnostics.save(id, job.run_id!, event);
    assert.equal(diagnostics.page(id, 0, through).length, 1);
    store.search.rebuild(id, store.get(id), store.evidenceRoot);
    assert.ok(store.search.search(id, "unmistakable", "evidence").includes(proof.id));
    store.status(id, "active");
    assert.deepEqual(store.events(id).slice(0, events.length), events);
    store.remove(id);
    for (const table of [
      "platform_event_archive",
      "platform_diagnostic_archive",
      "platform_evidence_archive",
      "platform_graph_records",
    ])
      assert.equal(Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention validates policy instead of accepting an invalid deletion window", () => {
  assert.equal(retentionPolicy({}).events_days, 90);
  assert.equal(retentionPolicy({ TESSERA_EVIDENCE_HOT_DAYS: "0" }).evidence_days, 0);
  assert.throws(() => retentionPolicy({ TESSERA_DIAGNOSTIC_HOT_DAYS: "-1" }));
});
