import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { buildApp } from "../../apps/server/src/app.js";

// Isolated local server + temporary project + fake resource cleanup. Never talks to Docker or model providers.
const directory = mkdtempSync(join(tmpdir(), "tessera-browser-delete-"));
const store = new Store(join(directory, "graph.db"));
const runtime = new RuntimeConfig(join(directory, "runtime.json"), { PI_MODEL: "browser-fixture-model",
  PI_BASE_URL: "https://provider.invalid/v1", PI_API_KEY: "browser-only-env-key", PI_PROVIDER_API: "openai-completions", TESSERA_MAX_WORKERS: "6" });
const project = store.create(createProjectSchema.parse({ title: "完整删除浏览器测试", origin: "https://example.test", goal: "检查确认框" }));
store.addEvidence(project.project.id, { title: "Original", content: "raw", encoding: "utf8", mime_type: "text/plain" });
let cleanupCalls = 0;
const auth = new OperatorAuth(join(directory, "operator.json"), { user: "browser-test", password: "browser-fixture-password" });
const app = buildApp(store, runtime, resolve("dist/web"), "browser-test-worker", { auth,
  cleanupProject: async (id, deletionId) => {
    cleanupCalls++;
    assert.equal(store.get(id).project.status, "stopped");
    if (cleanupCalls === 1) throw new Error("模拟卷清理失败，请重试");
    return { project_id: id, deletion_id: deletionId, resources_deleted: true };
  } });
await app.listen({ host: "127.0.0.1", port: 0 });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(app.listeningOrigin + "/#/settings");
  await page.locator('input[name="username"]').fill("browser-test");
  await page.locator('input[name="password"]').fill("browser-fixture-password");
  const login = page.waitForResponse(response => response.url().endsWith("/api/auth/login"));
  await page.locator('.login-card button[type="submit"]').click();
  assert.equal((await login).status(), 200);
  await page.locator(".app").waitFor();
  await page.goto(app.listeningOrigin + "/#/settings");
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  console.log("Settings page loaded after login.");
  for (const label of ["API 地址", "API Key", "总并发"]) assert.ok(await page.getByLabel(new RegExp("^" + label)).isDisabled(), label);
  assert.ok(await page.getByLabel(/^接口协议/).isDisabled());
  assert.ok(await page.getByLabel(/^选择模型|^模型/).isDisabled());
  assert.ok(!(await page.locator(".content").innerText()).includes("env"));
  await page.getByLabel(/^单项目并发/).fill("2");
  await page.getByLabel(/^单项目审核并发/).fill("3");
  const saved = page.waitForResponse(response => response.url().endsWith("/api/runtime") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal(runtime.value.max_project_workers, 2);
  assert.equal(runtime.value.max_project_review_workers, 3);
  assert.ok(!readFileSync(join(directory, "runtime.json"), "utf8").includes("browser-only-env-key"));
  console.log("Managed settings and editable save verified.");
  await page.goto(app.listeningOrigin + "/#/projects");
  const projectRow = page.getByRole("row").filter({ hasText: project.project.title });
  await projectRow.getByRole("button", { name: "更多项目操作", exact: true }).click();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/deletion-plan")),
    page.getByRole("menuitem", { name: "删除项目", exact: true }).click(),
  ]);
  const dialog = page.getByRole("dialog", { name: "项目操作" });
  const confirm = dialog.getByRole("button", { name: "永久删除全部资源", exact: true });
  await confirm.waitFor();
  assert.ok((await dialog.innerText()).includes(`tessera-workspace-${project.project.id}`));
  console.log("Deletion confirmation loaded.");
  for (const text of ["Pi 会话", "待补交结果", "全部归档证据", "无法撤销", "已删除的部分资源不会恢复"])
    assert.ok((await dialog.innerText()).includes(text), text);
  await confirm.click(); // The required checkbox prevents any delete request.
  assert.equal(cleanupCalls, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("heading", { name: "删除项目", exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/project-delete-mobile.png", fullPage: true });
  await confirm.click();
  await dialog.getByRole("alert").filter({ hasText: "模拟卷清理失败" }).waitFor();
  assert.equal(cleanupCalls, 1);
  assert.ok(store.get(project.project.id).project.deletion);
  const deleted = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.project.id}`) && response.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "重试完整删除", exact: true }).click();
  assert.equal((await deleted).status(), 204);
  await dialog.waitFor({ state: "detached" });
  assert.equal(cleanupCalls, 2);
  assert.throws(() => store.get(project.project.id));
  assert.deepEqual(pageErrors, []);
  console.log("Browser checks passed: managed settings disabled, editable save excludes env key, complete delete scope, checkbox, mobile layout, failure/retry and successful removal.");
} catch (error) {
  if (page) console.error("Browser QA state:", page.url(), (await page.locator("body").innerText()).slice(0, 3000));
  throw error;
} finally {
  await browser?.close(); await app.close(); store.close();
  rmSync(directory, { recursive: true, force: true });
}
