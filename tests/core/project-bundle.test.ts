import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { DiagnosticRecords } from "../../packages/core/src/diagnostics.js";
import { exportProjectBundle, importProjectBundle } from "../../packages/core/src/bundle.js";
import { readZip, writeZip } from "../../packages/core/src/archive.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema } from "../../packages/protocol/src/traffic.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp } from "../helpers/server.js";

const projectId = (store: Store, title: string) =>
  store.create(createProjectSchema.parse({ title, origin: "https://bundle.example.test", goal: "Roundtrip" })).project
    .id;

test("project bundle restores graph, evidence, traffic, diagnostics, events, runs and search, and the project can continue", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "tessera-bundle-source-")),
    targetDir = mkdtempSync(join(tmpdir(), "tessera-bundle-target-")),
    bundle = join(targetDir, "project.zip");
  const source = new Store(join(sourceDir, "tessera.db"));
  let target: Store | undefined;
  try {
    const id = projectId(source, "Bundle roundtrip");
    const evidence = source.addEvidence(id, {
      title: "Raw proof",
      content: "unmistakable bundle evidence body",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    source.mutate(id, "fixture.bundle-fact", true, (graph) => {
      graph.facts.push({
        id: "f-bundle",
        description: "Bundle fixture fact",
        graph_id: "main",
        evidence_ids: [evidence.id],
        created_at: new Date().toISOString(),
        conclusion: "Bundle fact",
        status: "observed",
      });
    });
    // A running Decide lease must be importable: the snapshot cannot keep it alive.
    const job = source.claim(id, "worker-1", 0)!;
    const diagnostics = new DiagnosticRecords(source.db);
    diagnostics.save(id, job.run_id!, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "run_end",
      data: { reason: "bundle fixture" },
    });
    const bodyId = randomUUID(),
      body = Buffer.from("traffic body survives the bundle");
    source.traffic.appendBody(id, bodyId, 0, body);
    source.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "flow-1",
        created_at: new Date().toISOString(),
        method: "POST",
        url: "https://bundle.example.test/login",
        host: "bundle.example.test",
        status: 200,
        request: { head: "POST /login HTTP/1.1", body_id: bodyId, size: body.length },
      }),
    ]);
    source.traffic.setStatus(id, { state: "active", dropped: 2, blocked: 1, guard: true });
    const report = new Reports(source).create(id);
    const revision = source.get(id).revision;

    const manifest = await exportProjectBundle(source, id, bundle);
    assert.equal(manifest.project.id, id);
    assert.equal(manifest.counts.evidence, 1);
    assert.equal(manifest.counts.traffic, 1);
    assert.ok(manifest.counts.diagnostics >= 1);
    assert.ok(manifest.files["evidence/" + evidence.id]);
    assert.ok(readFileSync(bundle).subarray(0, 2).toString() === "PK");

    target = new Store(join(targetDir, "tessera.db"));
    const imported = await importProjectBundle(target, bundle);
    assert.equal(imported.project_id, id);
    assert.equal(imported.status, "active");
    assert.equal(imported.warnings.length, 0);

    const graph = target.get(id);
    assert.equal(graph.project.title, "Bundle roundtrip");
    assert.equal(graph.revision, revision);
    assert.equal(graph.project.reason, null, "an imported snapshot never keeps a live Decide lease");
    assert.equal(
      target.evidenceContent(id, evidence.id).bytes.toString(),
      "unmistakable bundle evidence body",
      "evidence originals are restored byte for byte",
    );
    const runs = target.runs(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "interrupted", "a run that was in flight cannot resume");
    assert.match(runs[0].error || "", /Import/);
    const diagnosticsThrough = diagnostics.highwater(id);
    assert.equal(new DiagnosticRecords(target.db).highwater(id), diagnosticsThrough);
    assert.equal(target.events(id).length, source.events(id).length);
    assert.equal(graph.usage.length, source.get(id).usage.length);
    const traffic = target.traffic.get(id, "flow-1")!;
    assert.equal(traffic.status, 200);
    assert.equal(target.traffic.messageBody(id, traffic.request).toString(), body.toString());
    assert.equal(target.traffic.status(id).dropped, 2);
    assert.ok(target.db.prepare("SELECT 1 FROM platform_reports WHERE id=?").get(report.id));
    assert.ok(target.search.search(id, "unmistakable", "evidence").includes(evidence.id));

    // Continue working: the imported project must be claimable again.
    const next = target.claim(id, "worker-2", 0)!;
    assert.ok(next.run_id);
    assert.equal(target.execution.get(id, next.run_id!)!.status, "running");
    await assert.rejects(() => importProjectBundle(target!, bundle), /已存在/);
  } finally {
    source.close();
    target?.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("bundle export/import API roundtrip refuses duplicate ids and invalid archives", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "tessera-bundle-api-source-")),
    targetDir = mkdtempSync(join(tmpdir(), "tessera-bundle-api-target-"));
  const source = new Store(join(sourceDir, "tessera.db")),
    target = new Store(join(targetDir, "tessera.db"));
  const sourceApp = buildApp(source, new RuntimeConfig(join(sourceDir, "config.json")), join(sourceDir, "web"));
  const targetApp = buildApp(target, new RuntimeConfig(join(targetDir, "config.json")), join(targetDir, "web"));
  try {
    const id = projectId(source, "API bundle");
    source.addEvidence(id, {
      title: "Proof",
      content: "api bundle evidence",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const exported = await sourceApp.inject({ method: "GET", url: `/api/projects/${id}/bundle` });
    assert.equal(exported.statusCode, 200);
    assert.match(String(exported.headers["content-type"]), /application\/zip/);
    assert.match(String(exported.headers["content-disposition"]), /attachment/);
    assert.equal(exported.rawPayload.subarray(0, 2).toString(), "PK");

    const imported = await targetApp.inject({
      method: "POST",
      url: "/api/projects/import",
      headers: { "content-type": "application/zip" },
      payload: exported.rawPayload,
    });
    assert.equal(imported.statusCode, 201, imported.body);
    assert.equal(imported.json().project_id, id);
    assert.equal(target.get(id).project.title, "API bundle");

    const duplicate = await targetApp.inject({
      method: "POST",
      url: "/api/projects/import",
      headers: { "content-type": "application/zip" },
      payload: exported.rawPayload,
    });
    assert.equal(duplicate.statusCode, 409);

    const invalid = join(targetDir, "invalid.zip");
    writeFileSync(invalid, Buffer.from("not a zip"));
    const rejected = await targetApp.inject({
      method: "POST",
      url: "/api/projects/import",
      headers: { "content-type": "application/zip" },
      payload: readFileSync(invalid),
    });
    assert.equal(rejected.statusCode, 422);
  } finally {
    await sourceApp.close();
    await targetApp.close();
    source.close();
    target.close();
    const tempRoot = join(sourceDir, "bundle-tmp");
    assert.ok(
      !existsSync(tempRoot) || readdirSync(tempRoot).length === 0,
      "export/import leave no temporary bundle files behind",
    );
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("a bundle is prepared first and then streamed once, so the page never downloads a half-built archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-bundle-twophase-"));
  const store = new Store(join(dir, "tessera.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "web"));
  try {
    const id = projectId(store, "Two-phase export");
    store.addEvidence(id, { title: "Proof", content: "two phase body", encoding: "utf8", mime_type: "text/plain" });

    const prepared = await app.inject({ method: "POST", url: `/api/projects/${id}/bundles` });
    assert.equal(prepared.statusCode, 201, prepared.body);
    const body = prepared.json() as { url: string; filename: string; size: number; bundle_id: string };
    assert.equal(body.filename, `${id}-bundle.zip`);
    assert.equal(body.url, `/api/projects/${id}/bundles/${body.bundle_id}`);
    assert.ok(body.size > 0, "the prepared archive reports its size before the download starts");

    const download = await app.inject({ method: "GET", url: body.url });
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers["content-disposition"]), /attachment/);
    assert.equal(download.headers["content-length"], String(body.size));
    assert.equal(download.headers["cache-control"], "no-store");
    assert.equal(download.rawPayload.subarray(0, 2).toString(), "PK");

    const replay = await app.inject({ method: "GET", url: body.url });
    assert.equal(replay.statusCode, 404, "a prepared download is handed out once");

    const other = projectId(store, "Other project");
    const fresh = await app.inject({ method: "POST", url: `/api/projects/${id}/bundles` });
    const freshUrl = (fresh.json() as { url: string }).url;
    const wrongProject = await app.inject({
      method: "GET",
      url: freshUrl.replace(`/projects/${id}/`, `/projects/${other}/`),
    });
    assert.equal(wrongProject.statusCode, 404, "a prepared archive only downloads through its own project");
    // The rejected request must not consume or delete the prepared archive.
    assert.equal((await app.inject({ method: "GET", url: freshUrl })).statusCode, 200);
  } finally {
    await app.close();
    store.close();
    const tempRoot = join(dir, "bundle-tmp");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const leftover = existsSync(tempRoot) ? readdirSync(tempRoot) : [];
    assert.deepEqual(leftover, [], "nothing is left in the bundle temp root");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bundle whose entry no longer matches the manifest checksum is rejected before writing records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-bundle-tamper-")),
    bundle = join(dir, "clean.zip"),
    tampered = join(dir, "tampered.zip");
  const source = new Store(join(dir, "source", "tessera.db"));
  let target: Store | undefined;
  try {
    const id = projectId(source, "Tamper fixture");
    source.addEvidence(id, { title: "Proof", content: "tamper proof", encoding: "utf8", mime_type: "text/plain" });
    await exportProjectBundle(source, id, bundle);
    const entries: { name: string; bytes: Buffer }[] = [];
    await readZip(bundle, (name, bytes) => void entries.push({ name, bytes }));
    const graph = entries.find((entry) => entry.name === "graph.json")!;
    graph.bytes = Buffer.from(graph.bytes.toString().replace("Tamper fixture", "Tampered fixture"));
    await writeZip(tampered, entries);
    target = new Store(join(dir, "target", "tessera.db"));
    await assert.rejects(() => importProjectBundle(target!, tampered), /校验和不匹配/);
    assert.equal(target.list().length, 0, "no project row is written by a rejected bundle");
    assert.equal(existsSync(join(target.evidenceRoot, id)), false, "no evidence directory is left behind");
  } finally {
    source.close();
    target?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bundle export reads retention-archived events, diagnostics and evidence and restores them hot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-bundle-archive-")),
    sourceDir = join(dir, "source"),
    targetDir = join(dir, "target"),
    bundle = join(dir, "archived.zip");
  const source = new Store(join(sourceDir, "tessera.db"));
  let target: Store | undefined;
  try {
    const id = projectId(source, "Archived fixture");
    const evidence = source.addEvidence(id, {
      title: "Archived proof",
      content: "archived bundle evidence",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const job = source.claim(id, "worker-1", 0)!;
    new DiagnosticRecords(source.db).save(id, job.run_id!, {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: "run_end",
      data: { archived: true },
    });
    source.status(id, "stopped");
    const through = new DiagnosticRecords(source.db).highwater(id);
    source.retention.archive(
      { events_days: 1, diagnostics_days: 1, evidence_days: 1, batch: 1000 },
      Date.now() + 172_800_000,
    );
    assert.equal(existsSync(join(source.evidenceRoot, id, evidence.id)), false, "the loose evidence file was archived");
    await exportProjectBundle(source, id, bundle);
    target = new Store(join(targetDir, "tessera.db"));
    await importProjectBundle(target, bundle);
    assert.equal(target.evidenceContent(id, evidence.id).bytes.toString(), "archived bundle evidence");
    assert.equal(new DiagnosticRecords(target.db).highwater(id), through);
    assert.ok(target.runs(id).length >= 1);
    assert.ok(target.events(id).length >= 2);
  } finally {
    source.close();
    target?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
