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

const dir = mkdtempSync(join(tmpdir(), "tessera-settings-browser-"));
const store = new Store(join(dir, "test.db"));
store.create(createProjectSchema.parse({ title: "设置页验收", origin: "https://example.test", goal: "只验收界面" }));
const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), resolve("dist/web"), "fixture-worker-token", {
  auth: new OperatorAuth(join(dir, "operator.json"), { user: "fixture", password: "fixture-browser-password" }),
});
const output = resolve("test-results/settings");
mkdirSync(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.TESSERA_BROWSER_BIN ? { executablePath: process.env.TESSERA_BROWSER_BIN } : {}),
});
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.ok(
    (
      await page.request.post(`${app.listeningOrigin}/api/auth/login`, {
        data: { username: "fixture", password: "fixture-browser-password" },
      })
    ).ok(),
  );
  await page.goto(`${app.listeningOrigin}/#/settings`);
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  const nav = page.locator(".settings-nav");
  await nav.waitFor();

  const layout = () =>
    page.evaluate(() => {
      const content = document.querySelector(".content") as HTMLElement;
      const nav = document.querySelector(".settings-nav") as HTMLElement;
      const meta = document.querySelector(".page-settings .page-meta") as HTMLElement;
      const before = getComputedStyle(nav, "::before");
      const navBox = nav.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      const metaBox = meta.getBoundingClientRect();
      return {
        stuck: nav.dataset.stuck,
        beforeDisplay: before.display,
        scrollTop: content.scrollTop,
        navTop: navBox.top,
        navHeight: navBox.height,
        contentTop: contentBox.top,
        paddingTop: Number.parseFloat(getComputedStyle(content).paddingTop) || 0,
        metaTop: metaBox.top,
        metaBottom: metaBox.bottom,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
  const assertUnstuck = async () => {
    const state = await layout();
    assert.equal(state.stuck, "false");
    assert.equal(state.beforeDisplay, "none", "the padding band must not cover the page header at rest");
    assert.ok(state.metaBottom <= state.navTop, "the model status row must stay fully visible");
    return state;
  };

  let state = await assertUnstuck();
  const pills = await page
    .locator(".page-settings .page-meta > *")
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  assert.ok(pills.length >= 2 && pills.every((height) => height > 10), "page meta pills must render at full height");
  await page.screenshot({ path: join(output, "top-1280.png") });

  await page.evaluate(() => {
    (document.querySelector(".content") as HTMLElement).scrollTop = 240;
  });
  await page.waitForTimeout(250);
  state = await layout();
  assert.equal(state.stuck, "true");
  assert.equal(state.beforeDisplay, "block", "the padding band must fill the gap while the nav is stuck");
  assert.ok(
    Math.abs(state.navTop - (state.contentTop + state.paddingTop)) <= 1,
    "stuck nav must sit directly below the content padding",
  );
  await page.screenshot({ path: join(output, "stuck-1280.png") });

  await page.evaluate(() => {
    (document.querySelector(".content") as HTMLElement).scrollTop = 0;
  });
  await page.waitForTimeout(250);
  await assertUnstuck();

  // The reported screenshot was 575px wide; keep that width explicitly.
  for (const width of [575, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      (document.querySelector(".content") as HTMLElement).scrollTop = 0;
    });
    await page.waitForTimeout(250);
    state = await assertUnstuck();
    assert.ok(state.overflow <= 1, `settings page must not overflow at ${width}px`);
    await page.screenshot({ path: join(output, `top-${width}.png`) });
  }

  // 返回设置页会恢复滚动位置；吸顶状态必须跟着恢复，而不是等下一次滚动。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    (document.querySelector(".content") as HTMLElement).scrollTop = 500;
  });
  await page.waitForTimeout(250);
  assert.equal((await layout()).stuck, "true");
  await page.evaluate(() => {
    location.hash = "#/security";
  });
  await page.locator(".page-security").waitFor();
  await page.evaluate(() => {
    location.hash = "#/settings";
  });
  await page.locator(".settings-nav").waitFor();
  await page.waitForTimeout(400);
  const restored = await layout();
  assert.ok(restored.scrollTop > 0, "returning to settings restores its scroll position");
  assert.equal(restored.stuck, "true");
  assert.equal(restored.beforeDisplay, "block");

  // 飞书通知分区：Webhook 输入与两个开关都必须渲染出来。
  await page.locator("#settings-notifications").scrollIntoViewIfNeeded();
  await page.getByText("飞书通知", { exact: true }).first().waitFor();
  assert.equal(await page.locator("#settings-feishu-webhook").count(), 1, "webhook input renders");
  assert.equal(
    await page.locator("#settings-feishu-webhook").getAttribute("type"),
    "password",
    "webhook input is masked",
  );
  const toggles = ["有新发现时通知", "需要人工处理时通知"];
  for (const label of toggles) {
    assert.equal(
      (await page.locator(".settings-toggle", { hasText: label }).count()) >= 1,
      true,
      `toggle "${label}" renders`,
    );
  }
  // 默认不配置 Webhook：输入框为空，占位提示 https。
  assert.equal(await page.locator("#settings-feishu-webhook").inputValue(), "");
  await page.screenshot({ path: join(output, "notifications-1280.png") });
  await page.evaluate(() => {
    (document.querySelector(".content") as HTMLElement).scrollTop = 0;
  });
  await page.waitForTimeout(200);

  assert.deepEqual(errors, []);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      output,
      checks: ["meta row clipped-band regression", "sticky gap band", "575/390 widths", "no browser errors"],
    }) + "\n",
  );
} finally {
  await browser.close();
  await app.close();
  store.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dir, { recursive: true, force: true });
}
