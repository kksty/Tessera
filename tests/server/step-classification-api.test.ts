import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp } from "../helpers/server.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("人工分类 API 写入测试域与 focus，不改版本，非法域被拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-classification-api-"));
  const store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Classify", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Map subdomains", creator: "human" });
    const url = `/api/projects/${id}/fgs/steps/${step.id}/classification`;

    const ok = await app.inject({
      method: "PUT",
      url,
      payload: { test_domain: "recon", focus: "资产：子域" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    let saved = store.get(id).steps.find((item) => item.id === step.id)!;
    assert.equal(saved.test_domain, "recon");
    assert.equal(saved.focus, "资产：子域");
    assert.equal(saved.version, 1, "分类是标签，不改 Step 版本");

    const cleared = await app.inject({ method: "PUT", url, payload: { test_domain: null, focus: "" } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    saved = store.get(id).steps.find((item) => item.id === step.id)!;
    assert.equal(saved.test_domain, undefined);
    assert.equal(saved.focus, undefined);

    const invalid = await app.inject({ method: "PUT", url, payload: { test_domain: "web" } });
    assert.ok([400, 422].includes(invalid.statusCode), `unexpected ${invalid.statusCode}: ${invalid.body}`);
    saved = store.get(id).steps.find((item) => item.id === step.id)!;
    assert.equal(saved.test_domain, undefined, "非法域不会写入");

    const missing = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}/fgs/steps/s999/classification`,
      payload: { test_domain: "recon" },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
