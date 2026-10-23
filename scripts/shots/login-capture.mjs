import { chromium } from "playwright";

const base = process.env.BASE || "http://127.0.0.1:5173";
const theme = process.env.THEME || "light";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript((value) => {
  try {
    localStorage.setItem("tessera.theme", value);
  } catch {}
}, theme);
const page = await context.newPage();
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".login-card", { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `.tessera/ui-refresh/login-${theme}.png` });
await browser.close();
