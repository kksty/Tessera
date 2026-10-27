import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp } from "../helpers/server.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("诊断日志导出带一条测试域覆盖快照，统计口径与黑板一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-diagnostics-coverage-"));
  const store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Coverage export", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const recon = store.manualStep(id, {
      from: ["origin"],
      description: "Map subdomains",
      creator: "human",
      claim: true,
      test_domain: "recon",
    });
    store.fact(id, recon.id, { worker: "human", description: "admin.example.test resolves", evidence_ids: [] });
    store.manualStep(id, { from: ["origin"], description: "Unclassified probe", creator: "human" });

    const response = await app.inject({ method: "GET", url: `/api/projects/${id}/diagnostics` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "application/gzip");
    const lines = gunzipSync(response.rawPayload)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(lines[0].type, "manifest");
    const coverage = lines.find((line) => line.type === "domain_coverage");
    assert.ok(coverage, "导出文件里必须有测试域覆盖记录");
    assert.equal(coverage.schema, "tessera.domain-coverage.v1");
    assert.deepEqual(coverage.tasks, { total: 2, classified: 1, unclassified: 1, discarded: 0 });
    assert.equal(coverage.other_ratio, 0.5);
    assert.deepEqual(coverage.core_domains, { used: 1, total: 9, coverage_ratio: 0.1111 });
    assert.equal(coverage.cross_domain_tasks, 0);
    assert.equal(coverage.domains.length, 10, "空域也保留 0 条，便于看覆盖缺口");
    const reconRow = coverage.domains.find((row: any) => row.domain === "recon");
    assert.equal(reconRow.steps, 1);
    assert.equal(reconRow.facts, 1);
    assert.equal(reconRow.findings, 0);
    assert.match(coverage.note, /test_domain/);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
