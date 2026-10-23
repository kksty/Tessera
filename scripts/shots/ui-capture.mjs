import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE || "http://127.0.0.1:5173";
const out = process.env.OUT || ".tessera/ui-refresh";
const theme = process.env.THEME || "light";
const mobile = process.env.MOBILE === "1";
const width = Number(process.env.WIDTH) || (mobile ? 390 : 1440);
const height = Number(process.env.HEIGHT) || (mobile ? 844 : 900);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
});
await context.addInitScript((value) => {
  try {
    localStorage.setItem("tessera.theme", value);
  } catch {}
}, theme);
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") console.log("console-error:", message.text());
});

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".login-card", { timeout: 20000 });
await page.fill('input[name="username"], input[autocomplete="username"]', "user");
await page.fill('input[type="password"]', "passwd");
await page.click('button[type="submit"]');
await page.waitForSelector(".sidebar", { timeout: 20000 });
await page.waitForTimeout(1200);

const projects = await page.evaluate(async () => {
  const response = await fetch("/api/projects");
  return response.ok ? response.json() : [];
});
console.log("projects:", Array.isArray(projects) ? projects.map((p) => `${p.id}:${p.status}:${p.title}`).join(" | ") : projects);

const routes = [
  ["security", "#/security"],
  ["vulns", "#/vulns"],
  ["projects", "#/projects"],
];
const first = Array.isArray(projects) ? projects[0] : null;
if (first) {
  routes.push(
    ["project-overview", `#/projects/${first.id}/overview`],
    ["project-blackboard", `#/projects/${first.id}/blackboard`],
    ["project-findings", `#/projects/${first.id}/findings`],
  );
}
if (process.env.ALL === "1" && first) {
  routes.push(
    ["settings", "#/settings"],
    ["project-review", `#/projects/${first.id}/review`],
    ["project-assets", `#/projects/${first.id}/assets`],
    ["project-tasks", `#/projects/${first.id}/tasks`],
    ["project-timeline", `#/projects/${first.id}/timeline`],
    ["project-traffic", `#/projects/${first.id}/traffic`],
    ["project-evidence", `#/projects/${first.id}/evidence`],
    ["project-files", `#/projects/${first.id}/files`],
  );
}

for (const [name, hash] of routes) {
  await page.goto(`${base}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  await page.waitForTimeout(1500);
  if (mobile) {
    const open = await page.locator('.app[data-mobile-nav="true"]').count();
    if (open) {
      await page.locator(".nav-scrim").click({ force: true });
      await page.waitForTimeout(400);
    }
  }
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  console.log("shot", name);
}

if (mobile) {
  await page.locator(".nav-toggle").click({ force: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/sidebar.png`, fullPage: false });
  console.log("shot sidebar");
}

const templates = await page.evaluate(() => {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return null;
  const item = sidebar.querySelector(".nav-item");
  const count = sidebar.querySelector(".nav-count");
  return {
    sidebarWidth: sidebar.getBoundingClientRect().width,
    itemHeight: item?.getBoundingClientRect().height,
    countBox: count ? count.getBoundingClientRect().toJSON() : null,
    countAlign: count ? getComputedStyle(count).alignItems : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
  };
});
console.log("templates:", JSON.stringify(templates));

await browser.close();
