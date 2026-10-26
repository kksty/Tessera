import { commitPlan } from "../../tests/helpers/current-api.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { buildApp } from "../../apps/server/src/app.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  reviewSchema,
} from "../../packages/protocol/src/index.js";

// Synthetic local data only: no Dispatcher, target interaction or paid model requests.
const dir = mkdtempSync(join(tmpdir(), "tessera-browser-completion-")),
  store = new Store(join(dir, "graph.db"));
const graph = store.create(
  createProjectSchema.parse({
    title: "补全验收 · 合成数据",
    origin: "https://example.test",
    goal: "仅验证运行记录和交付界面",
  }),
);
const id = graph.project.id,
  plan = store.claim(id, "fixture-planner", 0)!,
  initial = store.get(id);
commitPlan(
  store,
  id,
  decideSchema.parse({
    worker: plan.worker,
    revision: initial.revision,
    observation_revision: initial.observation_revision,
    planning_revision: initial.planning_revision,
    steps: [
      { from: ["origin"], description: "合成的成功任务" },
      { from: ["origin"], description: "合成的中断任务" },
    ],
  }),
);
const proof = store.addEvidence(id, {
  title: "合成原始响应",
  content: "HTTP/1.1 200 OK\nSynthetic fixture, not a real vulnerability",
  mime_type: "text/plain",
  encoding: "utf8",
});
const execute = store.claim(id, "fixture-executor", 0)!;
store.usage(id, execute, 1200, 120, null, "fixture-request");
store.execute(
  id,
  execute.step_id!,
  executeSchema.parse({
    worker: execute.worker,
    facts: [{ description: "合成观测", evidence_ids: [proof.id] }],
    findings: [
      {
        title: "合成发现：对象访问权限",
        description: "此数据只用于界面与交付验证，不代表真实漏洞。",
        evidence_ids: [proof.id],
        severity: "high",
        severity_reason: "合成风险依据",
        impact: "合成的跨账户数据可见性",
        remediation: "按当前用户校验对象访问权限。",
        reproduction: {
          conditions: ["两个合成账户"],
          steps: ["切换对象标识", "检查合成响应"],
          expected: "拒绝访问",
          observed: "返回合成记录",
        },
        identity: {
          category: "custom_access_control",
          host: "example.test",
          protocol: "https",
          method: "GET",
          path: "/api/records",
          parameter: "id",
        },
      },
    ],
    summary: "合成任务完成",
  }),
);
const first = store.get(id).findings[0],
  review = store.claim(id, "fixture-reviewer", 0)!;
store.review(
  id,
  first.id,
  reviewSchema.parse({
    kind: "vulnerability",
    worker: review.worker,
    finding_version: first.version,
    verdict: "pass",
    reason: "合成审核，仅用于界面验证",
    evidence_ids: [proof.id],
  }),
);
const followup = store.claim(id, "fixture-replanner", 0)!,
  current = store.get(id);
commitPlan(
  store,
  id,
  decideSchema.parse({
    worker: followup.worker,
    revision: current.revision,
    observation_revision: current.observation_revision,
    planning_revision: current.planning_revision,
  }),
);
const uncertain = store.claim(id, "fixture-interrupted", 0)!;
store.externalAction(id, uncertain);
store.release(id, uncertain, "合成的进程中断；没有实际 shell 或目标请求");
store.submitFinding(
  id,
  findingSchema.parse({ title: "同身份候选", description: "合成的重复候选", identity: first.identity }),
);
new Reports(store).create(id);
const auth = new OperatorAuth(join(dir, "operator.json"), {
  user: "browser-test",
  password: "browser-fixture-password",
});
const app = buildApp(
  store,
  new RuntimeConfig(join(dir, "runtime.json")),
  resolve("dist/web"),
  "browser-fixture-token",
  { auth },
);
const output = resolve("test-results/completion");
mkdirSync(output, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TESSERA_BROWSER_BIN ? { executablePath: process.env.TESSERA_BROWSER_BIN } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${app.listeningOrigin}/#/projects/${id}/findings`);
  await page.locator('input[name="username"]').fill("browser-test");
  await page.locator('input[name="password"]').fill("browser-fixture-password");
  await page.locator('.login-card button[type="submit"]').click();
  await page.getByRole("heading", { name: "发现", exact: true }).waitFor();
  const card = page.locator(`#finding-${first.id}`);
  await card.waitFor();
  await card.getByText("合成的跨账户数据可见性", { exact: true }).waitFor();
  // 核对提示默认折叠，展开后仍能看到重复候选与操作入口。
  const duplicates = page.locator(".duplicates-panel");
  assert.equal(await duplicates.evaluate((el) => (el as HTMLDetailsElement).open), false, "核对提示默认收起");
  await duplicates.locator("summary").click();
  await page.getByText("重复候选", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "findings-desktop.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await page.locator('.report-row a[href$="format=zip"]').first().click();
  await (await download).saveAs(join(output, "synthetic-report.zip"));
  await card.click();
  const panel = page.locator(".finding-detail-panel");
  await panel.getByRole("button", { name: /修订内容|继续修订草稿/ }).click();
  await panel.getByLabel("风险等级").selectOption("medium");
  await panel.getByLabel("实际影响", { exact: true }).fill("浏览器补充的合成影响");
  await panel.getByRole("button", { name: "提交修订并重新审核", exact: true }).click();
  await panel.getByText("浏览器补充的合成影响", { exact: true }).waitFor();
  await page.getByText("输入已变化，快照过期", { exact: true }).waitFor();
  assert.equal(store.get(id).findings[0].review_status, "pending");
  await page.getByRole("button", { name: "生成报告快照", exact: true }).click();
  await page.getByText("当前快照", { exact: true }).waitFor();
  assert.equal(
    new Reports(store).list(id)[0].finding_count,
    0,
    "a revised pending finding must not enter the new report",
  );
  await page.locator(".sidebar").getByRole("button", { name: "人工重试", exact: true }).click();
  await page.getByRole("heading", { name: "人工重试", exact: true }).waitFor();
  await page.getByText("先判断，再重试", { exact: true }).waitFor();
  await page.getByText("需人工检查", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "retry-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "确认重试", exact: true }).click();
  const retryDialog = page.getByRole("dialog", { name: "确认人工重试", exact: true });
  await retryDialog.waitFor();
  await retryDialog.getByRole("checkbox").check();
  await retryDialog.getByRole("button", { name: "确认重试", exact: true }).click();
  await page.getByText("没有待人工重试的运行", { exact: true }).waitFor();
  assert.equal(store.get(id).steps.find((s) => s.id === uncertain.step_id)!.blocked_run_id, undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "retry-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `Retry page horizontal overflow: ${overflow}px`);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "ok",
      checks: [
        "structured finding edit",
        "review invalidation",
        "duplicates",
        "snapshot stale",
        "report ZIP download",
        "manual retry page",
        "explicit retry",
        "mobile overflow",
      ],
      output,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  assert.ok(
    resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith("tessera-browser-completion-"),
  );
  rmSync(dir, { recursive: true, force: true });
}
