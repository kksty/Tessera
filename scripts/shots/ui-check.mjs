import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE || "http://127.0.0.1:5173";
const out = ".tessera/ui-refresh/check";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".login-card", { timeout: 20000 });
await page.fill('input[name="username"], input[autocomplete="username"]', "user");
await page.fill('input[type="password"]', "passwd");
await page.click('button[type="submit"]');
await page.waitForSelector(".sidebar", { timeout: 20000 });

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

await page.goto(`${base}/#/vulns`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".severity-tabs", { timeout: 15000 });
await page.waitForTimeout(1000);

const badge = await page.evaluate(() => {
  const item = [...document.querySelectorAll(".sidebar .nav-item")].find((node) =>
    node.textContent?.includes("漏洞库"),
  );
  const count = item?.querySelector(".nav-count");
  if (!item || !count) return null;
  const itemBox = item.getBoundingClientRect();
  const countBox = count.getBoundingClientRect();
  const style = getComputedStyle(item);
  const badges = [...document.querySelectorAll(".sidebar .nav-count")].map((node) => {
    const row = node.closest(".nav-item");
    if (!row) return null;
    const rowBox = row.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    const box = node.getBoundingClientRect();
    return {
      text: node.textContent,
      rightGap: rowBox.right - parseInt(rowStyle.paddingRight, 10) - box.right,
      width: box.width,
    };
  });
  return {
    rightGap: itemBox.right - parseInt(style.paddingRight, 10) - countBox.right,
    pending: count.dataset.pending,
    countCenterDelta: Math.abs(
      (countBox.top + countBox.bottom) / 2 - (itemBox.top + itemBox.bottom) / 2,
    ),
    countHeight: countBox.height,
    badges,
  };
});
assert(badge !== null, "sidebar vuln badge missing");
if (badge) {
  assert(Math.abs(badge.rightGap) <= 1, `badge not right-aligned: ${JSON.stringify(badge)}`);
  assert(badge.pending === "true", "sidebar vuln badge should carry the pending state");
  assert(badge.countCenterDelta <= 1, `badge not vertically centered: ${JSON.stringify(badge)}`);
  assert(Math.abs(badge.countHeight - 18) <= 1, `badge height changed: ${JSON.stringify(badge)}`);
  for (const entry of badge.badges) {
    assert(Math.abs(entry.rightGap) <= 1, `count right edges differ: ${JSON.stringify(entry)}`);
    assert(Math.abs(entry.width - 20) <= 1, `count width differs: ${JSON.stringify(entry)}`);
  }
}

const tabs = await page.locator(".severity-tabs button").count();
assert(tabs >= 2, `expected severity tabs, found ${tabs}`);
const groupCount = await page.locator(".vuln-group").count();
assert(groupCount >= 1, "expected at least one severity group");
const headerText = await page.locator(".vuln-group-toggle").first().innerText();
assert(/中危/.test(headerText), `group header missing severity: ${headerText}`);
await page.screenshot({ path: `${out}/vulns-grouped.png` });

const firstGroup = page.locator(".vuln-group").first();
const toggle = firstGroup.locator(".vuln-group-toggle");
await toggle.click();
await page.waitForTimeout(250);
assert((await toggle.getAttribute("aria-expanded")) === "false", "group did not collapse");
assert((await firstGroup.locator("tr.clickable").count()) === 0, "collapsed group still renders rows");
await page.screenshot({ path: `${out}/vulns-collapsed.png` });
await toggle.click();
await page.waitForTimeout(250);
assert((await firstGroup.locator("tr.clickable").count()) > 0, "group did not expand");

await page.locator(".severity-tabs button", { hasText: "中危" }).click();
await page.waitForTimeout(250);
assert(
  (await page.locator('.severity-tabs button[aria-pressed="true"]').innerText()).includes("中危"),
  "severity filter did not activate",
);
assert((await page.locator(".vuln-group").count()) === 1, "severity filter should leave one group");

await page.fill(".vulns-toolbar .search-input input", "Tomcat");
await page.waitForTimeout(300);
const visibleRows = await page.locator(".vuln-group tr.clickable").count();
assert(visibleRows === 1, `search should leave one row, found ${visibleRows}`);
await page.screenshot({ path: `${out}/vulns-search.png` });

await page.locator(".vulns-toolbar .button", { hasText: "重置" }).click();
await page.waitForTimeout(300);
assert((await page.locator(".vuln-group tr.clickable").count()) > 1, "reset should restore rows");

const eyebrow = await page.locator(".page-header .eyebrow").first().isVisible();
assert(!eyebrow, "page eyebrow should be hidden to avoid duplicating the breadcrumb");

const projects = await page.evaluate(async () => {
  const response = await fetch("/api/projects");
  return response.ok ? response.json() : [];
});
const firstProject = Array.isArray(projects) ? projects[0] : null;
if (firstProject) {
  await page.goto(`${base}/#/projects/${firstProject.id}/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".project-header", { timeout: 15000 });
  await page.waitForTimeout(800);
  const expand = page.locator(".banner .button", { hasText: "展开" });
  if (await expand.count()) {
    const text = page.locator(".banner-text");
    const clampedHeight = (await text.boundingBox())?.height ?? 0;
    await expand.click();
    await page.waitForTimeout(220);
    const expandedHeight = (await text.boundingBox())?.height ?? 0;
    assert(expandedHeight > clampedHeight, "long error banner did not expand");
    await page.locator(".banner .button", { hasText: "收起" }).click();
    await page.waitForTimeout(220);
    const collapsedAgain = (await text.boundingBox())?.height ?? 0;
    assert(collapsedAgain <= clampedHeight + 1, "long error banner did not collapse");
    await page.screenshot({ path: `${out}/overview-error-collapsed.png` });
  }
  const groupStyle = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".nav-group-label")].find((node) =>
      node.textContent?.includes("探索"),
    );
    if (!label) return null;
    const style = getComputedStyle(label);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing };
  });
  assert(groupStyle !== null, "project nav group label missing");
  if (groupStyle) assert(groupStyle.fontSize === "11px", `nav group font size: ${groupStyle.fontSize}`);
}

console.log(JSON.stringify({ badge, tabs, groupCount, visibleRows, eyebrow }, null, 2));
if (failures.length) {
  console.error("FAILURES:\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("all vulnerability checks passed");
}
await browser.close();
