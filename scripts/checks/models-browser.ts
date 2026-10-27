import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { chromium } from "playwright";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { Store } from "../../packages/core/src/store.js";
import { buildApp } from "../../apps/server/src/app.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { modelCatalog } from "../../packages/models/src/runtime.js";

// Production UI, Pi catalog and local protocol fixture. No external provider or Docker requests.
const dir = mkdtempSync(join(tmpdir(), "tessera-model-browser-"));
const store = new Store(join(dir, "graph.db")),
  runtime = new RuntimeConfig(join(dir, "runtime.json"), {});
const auth = new OperatorAuth(join(dir, "operator.json"), { user: "models-test", password: "models-test-password" });
const app = buildApp(store, runtime, resolve("dist/web"), "models-test-worker", { auth });
const provider = Fastify();
let calls = 0;
provider.get("/v1/models", () => ({ data: [{ id: "fixture", context_window: 16000, max_output_tokens: 512 }] }));
provider.post("/v1/chat/completions", (req: any, reply) => {
  calls++;
  assert.equal(req.headers.authorization, "Bearer fixture-key");
  const budget = req.body.max_tokens ?? req.body.max_completion_tokens;
  assert.ok(budget > 400 && budget <= 512, `capacity probe spends the declared ceiling, got ${budget}`);
  assert.ok(JSON.stringify(req.body).length > 30000, "capacity probe sends a context sized from the window");
  reply.header("content-type", "text/event-stream");
  return `data: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
});
await provider.listen({ host: "127.0.0.1", port: 0 });
await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  await page.goto(app.listeningOrigin + "/#/settings");
  await page.locator('input[name="username"]').fill("models-test");
  await page.locator('input[name="password"]').fill("models-test-password");
  await page.locator('.login-card button[type="submit"]').click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  const main = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "主模型", exact: true }) });
  const review = page
    .locator("section.card")
    .filter({ has: page.getByRole("heading", { name: "审核模型", exact: true }) });
  for (const id of ["zai", "deepseek", "minimax"]) {
    const cfg = { id: "", provider: id, base_url: "", api_key: "", api: "openai-completions", context_window: 0 };
    const native = (await modelCatalog(cfg))[0];
    await main.locator("#settings-api-protocol").selectOption(native.api);
    const loaded = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/runtime/catalog") &&
        r.request().postDataJSON().base_url === native.base_url &&
        r.request().postDataJSON().api === native.api,
    );
    await main.locator("#settings-base-url").fill(native.base_url);
    await loaded;
    await main.getByRole("combobox", { name: "选择模型" }).selectOption(native.id);
    const details = main.getByLabel("Pi 模型配置");
    await details.getByText(new RegExp(native.api)).waitFor();
    assert.ok((await details.innerText()).includes(native.context_window.toLocaleString()));
    assert.ok((await details.innerText()).includes(native.max_output_tokens.toLocaleString()));
    await details.getByText(/目录已匹配/).waitFor();
    await details.getByText(/不等于部署真实上限/).waitFor();
    assert.equal(await main.getByLabel(/^上下文窗口/).inputValue(), "0");
    assert.equal(await main.locator("#settings-api-protocol").inputValue(), native.api);
    assert.equal(await main.locator("#settings-api-protocol").isDisabled(), false);
  }
  const loaded = page.waitForResponse((r) => r.url().endsWith("/api/runtime/models"));
  await main.getByRole("combobox", { name: "主模型接入方式" }).selectOption("custom");
  await main.locator("#settings-api-protocol").selectOption("openai-completions");
  await main.locator("#settings-base-url").fill(provider.listeningOrigin + "/v1/chat/completions");
  await main.locator("#settings-api-key").fill("fixture-key");
  await main.getByRole("combobox", { name: "选择模型" }).selectOption("__custom");
  await main.getByLabel("自定义模型名称", { exact: true }).fill("unknown-fixture");
  const defaults = main.getByLabel("Pi 模型配置");
  await defaults.getByText(/目录未匹配/).waitFor();
  await defaults.getByText(/128,000 tokens/).waitFor();
  await defaults.getByText(/16,384 tokens/).waitFor();
  await defaults.getByText(/不代表后端真实上限/).waitFor();
  await main.getByRole("button", { name: "获取模型", exact: true }).click();
  assert.equal((await loaded).status(), 200);
  await main.getByRole("combobox", { name: "选择模型" }).selectOption("fixture");
  assert.equal(await main.getByLabel(/^上下文窗口/).inputValue(), "16000");
  assert.equal(await main.getByLabel(/^输出上限/).inputValue(), "512");
  const detection = page.waitForResponse((r) => r.url().endsWith("/api/runtime/model-check"));
  await main.getByRole("button", { name: "检测 API", exact: true }).click();
  const detected = await detection;
  assert.equal(detected.status(), 200, await detected.text());
  const result = await detected.json();
  assert.equal(result.model.context_window, 16000);
  assert.equal(result.model.max_output_tokens, 512);
  await main.getByRole("status").filter({ hasText: "容量探测通过" }).waitFor();
  await main.getByRole("status").filter({ hasText: "输出上限" }).waitFor();
  assert.equal(calls, 1);
  const refresh = main.getByRole("button", { name: "刷新 Pi 目录", exact: true });
  await main
    .locator(".model-catalog-status")
    .getByText(/最近检查|离线模式/)
    .waitFor();
  if (await refresh.isEnabled()) {
    const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/runtime/catalog-refresh"));
    await refresh.click();
    assert.equal((await refreshed).status(), 200);
    await main
      .getByLabel("Pi 模型配置")
      .getByText(/16,000 tokens/)
      .first()
      .waitFor();
    assert.equal(calls, 1, "catalog refresh does not send a deployment completion request");
  }
  mkdirSync("test-results", { recursive: true });
  await main.locator(".model-picker").screenshot({ path: "test-results/models-effective-config-desktop.png" });
  const save = async () => {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/runtime") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.locator(".settings-savebar").waitFor({ state: "detached" });
  };
  await save();
  assert.equal(runtime.value.model.provider, "custom");
  assert.equal(runtime.value.model.base_url, provider.listeningOrigin + "/v1");
  assert.equal(runtime.value.model.api_key, "fixture-key");
  await review.getByRole("checkbox", { name: "使用独立审核模型" }).check();
  const native = (await modelCatalog({ ...runtime.value.model, provider: "minimax-cn", base_url: "" }))[0];
  await review.locator("#settings-review-api-protocol").selectOption(native.api);
  const reviewLoaded = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/runtime/catalog") &&
      r.request().postDataJSON().base_url === native.base_url &&
      r.request().postDataJSON().api === native.api,
  );
  await review.locator("#settings-review-base-url").fill(native.base_url);
  await reviewLoaded;
  await review.getByRole("combobox", { name: "选择模型" }).selectOption(native.id);
  await review.locator("#settings-review-api-key").fill("review-key");
  await save();
  assert.equal(runtime.value.review_model?.provider, "");
  assert.equal(runtime.value.review_model?.base_url, native.base_url);
  assert.equal(runtime.value.model.api_key, "fixture-key");
  await review.getByRole("checkbox", { name: "使用独立审核模型" }).uncheck();
  await save();
  assert.equal(runtime.value.review_model, undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "主模型", exact: true }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".sidebar")!.getBoundingClientRect().right <= 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/models-settings-mobile.png", fullPage: true });
  await main.locator(".model-picker").screenshot({ path: "test-results/models-effective-config-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "Pi model settings browser checks passed: endpoint catalog matching, exact metadata, custom endpoint probe, endpoint normalization, independent review/save/disable and mobile layout.",
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-4500));
  throw error;
} finally {
  await browser.close();
  await app.close();
  await provider.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
