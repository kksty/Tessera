import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { buildApp } from "../../apps/server/src/app.js";

const dir = mkdtempSync(join(tmpdir(), "tessera-usage-browser-"));
const store = new Store(join(dir, "test.db"));
const graph = store.create(createProjectSchema.parse({ title: "用量分桶验收", origin: "https://example.test", goal: "只验收界面" }));
const job = store.claim(graph.project.id, "usage-fixture", 0)!;
store.usage(graph.project.id, job, 1200, 120, null, "known", "completed", { input_uncached: 700, cache_read: 400, cache_write: 100 });
store.usage(graph.project.id, job, null, null, null, "interrupted", "started");
const run = store.execution.get(graph.project.id, job.run_id!)!;
run.capacity = { current: null, peak: 28000, generation: 1, source: "pi_session_projection_estimate" };
store.execution.save(run);
const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), resolve("dist/web"), "fixture-worker-token",
  { auth: new OperatorAuth(join(dir, "operator.json"), { user: "fixture", password: "fixture-browser-password" }) });
const output = resolve("test-results/usage"); mkdirSync(output, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.TESSERA_BROWSER_BIN ? { executablePath: process.env.TESSERA_BROWSER_BIN } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  assert.ok((await page.request.post(`${app.listeningOrigin}/api/auth/login`, { data: { username: "fixture", password: "fixture-browser-password" } })).ok());
  await page.goto(`${app.listeningOrigin}/#/projects/${graph.project.id}/overview`);
  await page.getByRole("button", { name: "查看项目用量", exact: true }).click();
  const usage = page.getByRole("dialog", { name: "模型用量", exact: true });
  await usage.waitFor();
  for (const [label, value] of [["输入总 Token", "1,200"], ["输出 Token", "120"],
    ["缓存读 / 写", "400 / 100"]]) {
    const counter = usage.locator(".usage-pop-grid > div").filter({ has: page.getByText(label, { exact: true }) });
    assert.match(await counter.locator("strong").textContent() ?? "", new RegExp("^" + value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  await usage.locator(".usage-pop-table tbody tr").filter({ hasText: "执行" }).waitFor();
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  await page.keyboard.press("Escape");
  await page.goto(`${app.listeningOrigin}/#/projects/${graph.project.id}/tasks`);
  await page.reload();
  await page.getByRole("tab", { name: "运行记录", exact: true }).click();
  const runs = page.locator(".tasks-runs");
  await runs.waitFor();
  await runs.locator("summary").first().click();
  await runs.getByText(/普通输入（SDK） 700 · 缓存读 400 \/ 写 100 tokens/).waitFor();
  await runs.getByText(/上下文估算 未知 · 峰值 28000 tokens · 压缩代次 1/).waitFor();
  await runs.getByText(/压缩后预留不足.*request_3.*26240/).waitFor();
  await runs.getByText(/压缩后预留不足.*request_3.*26240/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "runs-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ status: "passed", output, checks: ["usage buckets", "unknown requests", "Run counters", "mobile overflow", "no browser errors"] }) + "\n");
} finally {
  await browser?.close(); await app.close(); store.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dir, { recursive: true, force: true });
}
