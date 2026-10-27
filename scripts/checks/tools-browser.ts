import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import { commitPlan } from "../../tests/helpers/current-api.js";

const dir = mkdtempSync(join(tmpdir(), "tessera-tools-browser-"));
const store = new Store(join(dir, "test.db"));
const graph = store.create(
  createProjectSchema.parse({ title: "工具排行验收", origin: "https://example.test", goal: "只验收界面" }),
);
const projectId = graph.project.id;
const decide = store.claim(projectId, "tools-fixture", 0)!;
const snapshot = store.get(projectId);
commitPlan(
  store,
  projectId,
  decideSchema.parse({
    worker: decide.worker,
    revision: snapshot.revision,
    observation_revision: snapshot.observation_revision,
    planning_revision: snapshot.planning_revision,
    steps: [{ from: ["origin"], description: "Inspect the fixture endpoint" }],
  }),
);
const execute = store.claim(projectId, "tools-fixture", 1)!;
assert.equal(execute.kind, "execute");

const source = randomUUID();
let sequence = 0;
const event = (type: string, data: Record<string, unknown>) => ({
  id: randomUUID(),
  at: new Date(Date.now() - 10 * 60_000 + sequence * 1000).toISOString(),
  source_id: source,
  source_seq: ++sequence,
  type,
  data,
});
type Call = [tool: string, elapsed_ms: number, is_error: boolean, ended?: boolean];
const calls = (items: Call[]) => {
  const result = [];
  for (const [index, [tool, elapsed_ms, is_error, ended = true]] of items.entries()) {
    const tool_call_id = `${tool}-${index}-${sequence}`;
    result.push(event("tool_start", { tool, tool_call_id, generation: 0 }));
    if (ended) result.push(event("tool_end", { tool, tool_call_id, generation: 0, elapsed_ms, is_error }));
  }
  return result;
};
const decideEvents = calls([
  ["read_graph", 40, false],
  ["read_graph", 55, false],
  ["read_graph", 0, false, false],
  ["query_graph", 25, true],
]);
const executeEvents = calls([
  ["bash", 3200, false],
  ["bash", 2100, false],
  ["bash", 1800, false],
  ["bash", 900, true],
  ["bash", 2800, false],
  ["bash", 700, true],
  ["read", 12, false],
  ["read", 9, false],
  ["read", 15, false],
  ["read", 8, false],
  ["save_evidence", 480, false],
  ["save_evidence", 520, false],
]);
const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), resolve("dist/web"), "fixture-worker-token", {
  auth: new OperatorAuth(join(dir, "operator.json"), { user: "fixture", password: "fixture-browser-password" }),
});
const post = (job: typeof decide, events: unknown[]) =>
  app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/jobs/diagnostics`,
    headers: { "x-tessera-worker-token": "fixture-worker-token" },
    payload: { job, events },
  });
assert.equal((await post(decide, decideEvents)).statusCode, 200);
for (let offset = 0; offset < executeEvents.length; offset += 12) {
  const response = await post(execute, executeEvents.slice(offset, offset + 12));
  assert.equal(response.statusCode, 200, response.body);
}

const output = resolve("test-results/tools");
mkdirSync(output, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TESSERA_BROWSER_BIN ? { executablePath: process.env.TESSERA_BROWSER_BIN } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
  await page.goto(`${app.listeningOrigin}/#/projects/${projectId}/overview`);
  const card = page.locator("#overview-tools");
  await card.waitFor();
  await card.getByText("bash", { exact: true }).waitFor();
  const totals = card.locator(".tool-leaderboard-totals");
  assert.match(await totals.innerText(), /16\s*次调用/);
  assert.match(await totals.innerText(), /5\s*种工具/);
  assert.match(await totals.innerText(), /3\s*次失败/);
  assert.equal(await card.locator(".tool-rank-row").count(), 5);
  const first = await card.locator(".tool-rank-row").first().innerText();
  assert.match(first, /bash/);
  assert.match(first, /6\s*次/);
  assert.match(first, /2\s*次失败/);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(output, "card.png") });
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });

  // 没有审核调用时仍然保留筛选器，不能把用户困在空阶段里。
  await card.getByRole("button", { name: "审核", exact: true }).click();
  assert.equal(await card.locator(".tool-rank-row").count(), 0);
  await card.getByText("审核阶段还没有工具调用。", { exact: true }).waitFor();
  assert.ok(await card.getByRole("button", { name: "全部", exact: true }).isVisible());
  await card.getByRole("button", { name: "全部", exact: true }).click();

  await card.getByRole("button", { name: "决策", exact: true }).click();
  assert.equal(await card.locator(".tool-rank-row").count(), 2);
  assert.match(await card.locator(".tool-rank-row").first().innerText(), /read_graph/);
  assert.match(await totals.innerText(), /4\s*次调用/);
  await card.getByRole("button", { name: "执行", exact: true }).click();
  assert.equal(await card.locator(".tool-rank-row").count(), 3);
  assert.match(await card.locator(".tool-rank-row").first().innerText(), /bash/);
  await card.getByRole("button", { name: "全部", exact: true }).click();
  assert.equal(await card.locator(".tool-rank-row").count(), 5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "mobile.png") });
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  assert.deepEqual(errors, []);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      output,
      checks: [
        "tool ranking order",
        "phase filter counts",
        "empty phase keeps filters",
        "mobile overflow",
        "no browser errors",
      ],
    }) + "\n",
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dir, { recursive: true, force: true });
}
