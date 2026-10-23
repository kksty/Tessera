import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeConfig, configSchema } from "../../apps/server/src/runtime.js";
import { editableRuntimeUpdate } from "../../apps/web/src/runtime-config.js";
import { Store } from "../../packages/core/src/store.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { parse } from "yaml";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-config-")), file = join(dir, "runtime.json");
  return { dir, file, close() { rmSync(dir, { recursive: true, force: true }); } };
}

test("task runtime defaults to unlimited, supports explicit zero, and validates finite deadlines", () => {
  const f = fixture();
  try {
    const config = new RuntimeConfig(f.file, {});
    assert.equal(config.value.task_timeout_seconds, 0);
    assert.equal(config.value.tool_timeout_seconds, 0);
    assert.equal(config.value.closeout_seconds, 60);
    config.updatePublic({ task_timeout_seconds: 0, tool_timeout_seconds: 0 });
    assert.equal(new RuntimeConfig(f.file, {}).value.tool_timeout_seconds, 0);
    assert.equal(new RuntimeConfig(f.file, {}).value.task_timeout_seconds, 0);
    assert.equal(new RuntimeConfig(f.file, { TESSERA_TASK_TIMEOUT_SECONDS: "0" }).value.task_timeout_seconds, 0);
    for (const timeout of [-1, 1, 29]) assert.equal(configSchema.safeParse({ ...config.value, task_timeout_seconds: timeout }).success, false);
    assert.equal(configSchema.safeParse({ ...config.value, task_timeout_seconds: 30, closeout_seconds: 30 }).success, false);
    assert.equal(configSchema.safeParse({ ...config.value, task_timeout_seconds: 30, closeout_seconds: 10 }).success, true);
  } finally { f.close(); }
});

test("explicit env wins per field over existing configuration, while blank env falls back and zero remains explicit", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ max_workers: 3, debounce_ms: 1000, model: { id: "stored-model", base_url: "https://stored.test/v1", api_key: "stored-key", context_window: 64000 } }));
    const config = new RuntimeConfig(f.file, { PI_MODEL: "env-model", PI_BASE_URL: "", TESSERA_MAX_WORKERS: "7", TESSERA_DEBOUNCE_MS: "0", TESSERA_RESULT_REPAIRS: "0" });
    assert.equal(config.value.model.id, "env-model");
    assert.equal(config.value.model.base_url, "https://stored.test/v1");
    assert.equal(config.value.model.context_window, 64000);
    assert.equal(config.value.model.api, "openai-completions");
    assert.equal(config.value.max_workers, 7);
    assert.equal(config.value.debounce_ms, 0);
    assert.equal(config.value.result_repairs, 0);
    assert.ok(!config.readOnlyFields.includes("model.base_url"));
    assert.equal(new RuntimeConfig(f.file, {}).value.model.id, "stored-model");
  } finally { f.close(); }
});

test("saving other settings never persists env values/keys and removing overrides restores the original persisted values", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ model: { id: "stored-model", base_url: "https://stored.test/v1", api_key: "stored-key" } }));
    const config = new RuntimeConfig(f.file, { PI_MODEL: "env-model", PI_BASE_URL: "https://env.test/v1", PI_API_KEY: "env-private-key", TESSERA_MAX_WORKERS: "9" });
    const view = config.redacted();
    assert.equal(view.model.api_key, ""); assert.equal(view.model.api_key_set, true);
    const payload = editableRuntimeUpdate({ ...view, max_project_workers: 2 } as any);
    assert.equal(payload.model.id, undefined); assert.equal(payload.model.api_key, undefined); assert.equal(payload.model.base_url, undefined);
    assert.equal(payload.max_workers, undefined);
    config.updatePublic(payload);
    const raw = readFileSync(f.file, "utf8");
    for (const value of ["env-model", "env.test", "env-private-key", "read_only_fields", "api_key_set"]) assert.ok(!raw.includes(value), value);
    const reopened = new RuntimeConfig(f.file, {});
    assert.equal(reopened.value.model.id, "stored-model");
    assert.equal(reopened.value.model.api_key, "stored-key");
    assert.equal(reopened.value.max_workers, 4);
    assert.equal(reopened.value.max_project_workers, 2);
  } finally { f.close(); }
});

test("an env-only secret is not materialized into a new config file by an unrelated save", () => {
  const f = fixture();
  try {
    const config = new RuntimeConfig(f.file, { PI_API_KEY: "only-in-env", PI_MODEL: "only-env-model" });
    config.updatePublic({ max_workers: 5 });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { max_workers: 5 });
    assert.equal(config.value.model.api_key, "only-in-env");
    assert.equal(new RuntimeConfig(f.file, {}).value.model.api_key, "");
  } finally { f.close(); }
});

test("API writes to managed leaves/groups are rejected even when metadata is forged, and failed updates preserve disk", async () => {
  const f = fixture(), store = new Store(join(f.dir, "graph.db"));
  const config = new RuntimeConfig(f.file, { PI_MODEL: "locked-model", PI_API_KEY: "locked-key", TESSERA_MAX_WORKERS: "8" });
  const app = buildApp(store, config, join(f.dir, "no-web"));
  try {
    config.updatePublic({ debounce_ms: 200 });
    const before = readFileSync(f.file, "utf8");
    for (const payload of [{ model: { id: "changed" } }, { model: null }, { max_workers: 5 },
      { model: { api_key: "changed" }, read_only_fields: [] }]) {
      for (const headers of [undefined, { "x-tessera-worker-token": testWorkerToken }]) {
        const response = await app.inject({ method: "PUT", url: "/api/runtime", payload, headers });
        assert.equal(response.statusCode, 422);
        assert.ok(!response.body.includes("locked-key"));
      }
    }
    assert.equal(readFileSync(f.file, "utf8"), before);
    const success = await app.inject({ method: "PUT", url: "/api/runtime", payload: { model: { api: "anthropic-messages" } } });
    assert.equal(success.statusCode, 200);
    assert.equal(config.value.model.id, "locked-model");
  } finally { await app.close(); store.close(); f.close(); }
});

test("invalid explicit env fails validation and partial review env can use persisted review fields", () => {
  const f = fixture();
  try {
    for (const env of [{ TESSERA_MAX_WORKERS: "oops" }, { TESSERA_MAX_WORKERS: "0" }, { PI_PROVIDER_API: "bad-api" },
      { PI_BASE_URL: "file:///etc/passwd" }, { PI_CONTEXT_WINDOW: "1" }, { TESSERA_TASK_TIMEOUT_SECONDS: "30", TESSERA_CLOSEOUT_SECONDS: "30" },
      { PI_REVIEW_MODEL: "review-without-url" }]) assert.throws(() => new RuntimeConfig(f.file, env));
    const defaults = new RuntimeConfig(f.file, { TESSERA_TASK_TIMEOUT_SECONDS: "30" });
    assert.equal(defaults.value.closeout_seconds, 10);
    writeFileSync(f.file, JSON.stringify({ review_model: { id: "review", base_url: "https://review.test/v1", api_key: "old-key" } }));
    const review = new RuntimeConfig(f.file, { PI_REVIEW_API_KEY: "new-review-env-key", PI_REVIEW_CONTEXT_WINDOW: "262144" });
    assert.equal(review.value.review_model!.id, "review");
    assert.equal(review.value.review_model!.api_key, "new-review-env-key");
    assert.equal(review.value.review_model!.context_window, 262144);
    review.updatePublic({ max_workers: 6 });
    assert.ok(!readFileSync(f.file, "utf8").includes("new-review-env-key"));
  } finally { f.close(); }
});

test("changing persisted endpoints does not reuse old credentials, while blank keys on the same endpoint preserve them", () => {
  const f = fixture();
  try {
    const config = new RuntimeConfig(f.file, {});
    config.updatePublic({ model: { base_url: "https://one.test/v1", api_key: "original-key" } });
    config.updatePublic({ model: { base_url: "https://one.test/v1/", api_key: "" } });
    assert.equal(config.value.model.api_key, "original-key");
    config.updatePublic({ model: { base_url: "https://two.test/v1" } });
    assert.equal(config.value.model.api_key, "");
  } finally { f.close(); }
});

test("env-only review settings never copy the main key and leave no broken review model after overrides are removed", () => {
  const f = fixture();
  try {
    const config = new RuntimeConfig(f.file, { PI_API_KEY: "main-env-key", PI_REVIEW_MODEL: "review-env-model", PI_REVIEW_BASE_URL: "https://review.test/v1" });
    assert.equal(config.value.review_model!.api_key, "");
    config.updatePublic(editableRuntimeUpdate(config.redacted() as any));
    const raw = readFileSync(f.file, "utf8");
    assert.ok(!raw.includes("main-env-key")); assert.ok(!raw.includes("review-env-model"));
    assert.equal(new RuntimeConfig(f.file, {}).value.review_model, undefined);
  } finally { f.close(); }
});

test("Pi-native providers work without a custom endpoint and disabling review removes its saved key", () => {
  const f = fixture();
  try {
    const config = new RuntimeConfig(f.file, {});
    config.updatePublic({ model: { provider: "deepseek", id: "deepseek-flash", api_key: "main-key" },
      review_model: { provider: "minimax-cn", id: "MiniMax-M2.7", api_key: "review-key" } });
    assert.doesNotThrow(() => config.requireModel());
    assert.equal(config.value.model.context_window, 0);
    assert.equal(config.value.review_model!.api_key, "review-key");
    config.updatePublic({ review_model: { provider: "", id: "", base_url: "", api_key: "" } });
    assert.equal(config.value.review_model, undefined);
    assert.ok(!readFileSync(f.file, "utf8").includes("review-key"));
    config.updatePublic({ model: { provider: "zai" } });
    assert.equal(config.value.model.api_key, "");
    const env = new RuntimeConfig(f.file, { PI_PROVIDER: "minimax", PI_CONTEXT_WINDOW: "0", PI_MAX_OUTPUT_TOKENS: "4096" });
    assert.equal(env.value.model.provider, "minimax");
    assert.equal(env.value.model.max_output_tokens, 4096);
    assert.ok(env.readOnlyFields.includes("model.provider"));
    assert.ok(env.readOnlyFields.includes("model.max_output_tokens"));
  } finally { f.close(); }
});

test("Compose preserves optional env as blank and retains existing shared /data mounts", () => {
  const compose = parse(readFileSync("compose.yaml", "utf8"));
  const environment = compose.services["tessera-server"].environment;
  assert.equal(environment.PI_PROVIDER_API, "${PI_PROVIDER_API:-}");
  assert.equal(environment.TESSERA_MAX_WORKERS, "${TESSERA_MAX_WORKERS:-}");
  assert.equal(environment.TESSERA_MAX_PROJECT_REVIEW_WORKERS, "${TESSERA_MAX_PROJECT_REVIEW_WORKERS:-}");
  for (const service of ["tessera-server", "tessera-dispatcher"])
    assert.ok(compose.services[service].volumes.includes("${TESSERA_DATA_DIR:-./datas/tessera}:/data"));
  assert.ok(!compose.services["tessera-server"].volumes.some((mount: string) => mount.includes("docker.sock")));
});

test("Review concurrency defaults for old settings, persists and respects env locking", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ max_project_workers: 2 }));
    const config = new RuntimeConfig(f.file, {});
    assert.equal(config.value.max_project_review_workers, 1);
    config.updatePublic({ max_project_review_workers: 3 });
    assert.equal(new RuntimeConfig(f.file, {}).value.max_project_review_workers, 3);
    const managed = new RuntimeConfig(f.file, { TESSERA_MAX_PROJECT_REVIEW_WORKERS: "2" });
    assert.equal(managed.value.max_project_review_workers, 2);
    assert.ok(managed.readOnlyFields.includes("max_project_review_workers"));
    assert.throws(() => managed.updatePublic({ max_project_review_workers: 1 }), /部署配置/);
    for (const value of [0, -1, 1.5, 33])
      assert.equal(configSchema.safeParse({ ...config.value, max_project_review_workers: value }).success, false);
  } finally { f.close(); }
});
