import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright";
import { Store } from "../../packages/core/src/store.js";
import { buildApp } from "../../apps/server/src/app.js";
import { OperatorAuth } from "../../apps/server/src/operator-auth.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import {
  createProjectSchema,
  findingSchema,
  reviewSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";

import { scoreCvss } from "../../packages/core/src/cvss.js";
import { cvss, withImpactEvidence } from "../../tests/fixtures/cvss.js";
import { pendingReviews } from "../../packages/protocol/src/review-scheduling.js";
import { reportFields } from "../../tests/fixtures/report.js";

// Production assets and synthetic local data; no Dispatcher or model requests.
const dir = mkdtempSync(join(tmpdir(), "tessera-frontend-"));
const store = new Store(join(dir, "graph.db"));
const graph = store.create(
  createProjectSchema.parse({
    title: "前端显示验收 · 长项目名称与窄屏布局检查 abcdefghijklmnopqrstuvwxyz",
    origin: "https://example.test",
    goal: "验证界面排版、交互与按需加载",
    hints: [{ content: "仅使用合成数据" }],
  }),
);
const id = graph.project.id;
const step = store.manualStep(id, {
  from: ["origin"],
  description: "检查合成的登录页面与证据展示",
  creator: "human",
  claim: true,
});
const proof = store.addEvidence(id, {
  title: "合成响应",
  content: "Synthetic frontend fixture",
  mime_type: "text/plain",
  encoding: "utf8",
});
const observation = store.fact(id, step.id, {
  worker: "human",
  description: "合成页面的原始观测",
  conclusion: "合成页面可读取",
  evidence_ids: [proof.id],
});
store.submitStepFinding(
  id,
  step.id,
  "human",
  findingSchema.parse({
    title: "合成候选发现",
    description: "用于检查排版，不代表真实漏洞。",
    from: [observation.id],
    evidence_ids: [proof.id],
    severity: "medium",
  }),
);
store.manualConclude(id, step.id, "human", "合成观测完成");
store.mutate(id, "fixture.review-states", false, (g) => {
  const candidate = g.findings[0];
  g.findings.push(
    {
      ...candidate,
      id: "finding_pass",
      title: "合成通过发现",
      status: "confirmed",
      review_status: "pass",
      reviewed_version: 1,
      kind: "vulnerability",
      severity: "high",
      cvss: scoreCvss(withImpactEvidence(cvss.high, [proof.id])),
    },
    {
      ...candidate,
      id: "finding_rejected",
      title: "合成驳回发现",
      status: "rejected",
      review_status: "rejected",
      reviewed_version: 1,
    },
    {
      ...candidate,
      id: "finding_needs_evidence",
      title: "合成待补证发现",
      review_status: "needs_evidence",
      reviewed_version: 1,
    },
    {
      ...candidate,
      id: "finding_revised",
      title: "合成修订待复审",
      status: "confirmed",
      review_status: "pass",
      version: 2,
      reviewed_version: 1,
    },
    {
      ...candidate,
      id: "finding_info",
      title: "合成信息类发现",
      status: "confirmed",
      review_status: "pass",
      reviewed_version: 1,
      kind: "informational",
      severity: null,
      cvss: null,
    },
    { ...candidate, id: "finding_merged", title: "合成已合并发现", merged_into: "finding_pass" },
    { ...candidate, id: "finding_withdrawn", title: "合成已撤回发现", withdrawn_at: candidate.created_at },
  );
});
const auth = new OperatorAuth(join(dir, "operator.json"), {
  user: "frontend-test",
  password: "frontend-fixture-password",
});
const app = buildApp(
  store,
  new RuntimeConfig(join(dir, "runtime.json")),
  resolve("dist/web"),
  "frontend-fixture-token",
  { auth },
);
const output = resolve("test-results/frontend");
mkdirSync(output, { recursive: true });
const errors: string[] = [];
const layouts: unknown[] = [];
const layoutFailures: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function checkLogo(page: Page) {
  const mark = await page
    .locator(".logo-mark:visible")
    .first()
    .evaluate((el) => {
      const pieces = [...el.querySelectorAll("path")].map((path) => {
        const box = path.getBBox();
        return { x: box.x, y: box.y, width: box.width, height: box.height, fill: getComputedStyle(path).fill };
      });
      const size = el.getBoundingClientRect();
      return { pieces, viewBox: el.getAttribute("viewBox"), width: size.width, height: size.height };
    });
  assert.equal(mark.viewBox, "0 0 32 32", "Logo view box is 32");
  assert.equal(mark.pieces.length, 2, "Mark is one tile cut into two pieces");
  assert.ok(mark.width > 0 && Math.abs(mark.width - mark.height) < 0.5, "Logo renders square");
  const [base, accent] = mark.pieces;
  assert.notEqual(base.fill, accent.fill, "Accent piece must use its own colour");
  // 两片沿 45° 接缝错开，合起来正好是一片 25×25、居中于 32 画布的瓷砖。
  assert.ok(accent.x > base.x && accent.y > base.y, "Accent piece sits at the bottom-right of the seam");
  const left = Math.min(base.x, accent.x),
    top = Math.min(base.y, accent.y);
  const right = Math.max(base.x + base.width, accent.x + accent.width);
  const bottom = Math.max(base.y + base.height, accent.y + accent.height);
  assert.ok(Math.abs(right - left - 25) < 0.2 && Math.abs(bottom - top - 25) < 0.2, "Two pieces tile a 25×25 square");
  assert.ok(Math.abs(left - 3.5) < 0.2 && Math.abs(top - 3.5) < 0.2, "Mark is centred in its 32 view box");
}

/** 侧栏不再借用登录页的墨面：浅色必须是纸面，项目名在两套主题下都要读得清。
 *  这条检查盯住之前的事故：浅色侧栏仍是黑的，项目名继承成黑字，直接看不见。 */
async function checkSidebar(page: Page, theme: "light" | "dark") {
  const result = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")!;
    const chip = document.querySelector(".project-chip")!;
    const title = document.querySelector(".project-chip-text strong")!;
    const section = document.querySelector(".nav-section-label")!;
    return {
      theme: document.documentElement.dataset.theme,
      sidebarBg: getComputedStyle(sidebar).backgroundColor,
      chipBg: getComputedStyle(chip).backgroundColor,
      titleColor: getComputedStyle(title).color,
      mark: document.querySelector(".project-chip-mark")?.textContent?.trim() || "",
      title: title.textContent?.trim() || "",
      brandLeft: document.querySelector(".brand-symbol")!.getBoundingClientRect().x,
      chipLeft: chip.getBoundingClientRect().x,
      brandText: document.querySelector(".brand-text")!.getBoundingClientRect().x,
      titleLeft: title.getBoundingClientRect().x,
      navLabelLeft: document.querySelector(".nav-label")!.getBoundingClientRect().x,
      sectionLeft: section.getBoundingClientRect().x + parseFloat(getComputedStyle(section).paddingLeft),
    };
  });
  const parse = (color: string) =>
    color
      .match(/\d+(?:\.\d+)?/g)!
      .slice(0, 3)
      .map(Number);
  const luminance = (color: string) =>
    parse(color)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground: string, background: string) => {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };
  assert.equal(result.theme, theme, `侧栏检查应运行在${theme === "light" ? "浅色" : "深色"}主题`);
  assert.ok(result.title, "项目名应出现在侧栏");
  assert.equal(result.mark, "", "展开态项目名前面不应有首字图标");
  assert.ok(Math.abs(result.brandLeft - result.chipLeft) < 0.5, "品牌记号应与项目卡左边线对齐（顶格）");
  // 侧栏只有一条文字列：项目名、分组标题、导航文字都必须和字标 Tessera 的首字同列。
  for (const [left, label] of [
    [result.titleLeft, "项目名"],
    [result.sectionLeft, "分组标题"],
    [result.navLabelLeft, "导航文字"],
  ] as const)
    assert.ok(Math.abs(left - result.brandText) < 0.5, `${label}应与字标首字同列（${left} vs ${result.brandText}）`);
  assert.ok(
    contrast(result.titleColor, result.chipBg) >= 4.5,
    `项目名对比度不足：${result.titleColor} on ${result.chipBg}（${contrast(result.titleColor, result.chipBg).toFixed(2)}:1）`,
  );
  if (theme === "light") assert.ok(luminance(result.sidebarBg) > 0.75, `浅色侧栏不应是深色：${result.sidebarBg}`);
  else assert.ok(luminance(result.sidebarBg) < 0.1, `深色侧栏应保持深色：${result.sidebarBg}`);
}

async function checkIconInputs(page: Page) {
  const inputs = await page.locator(".input-with-icon:visible, .search-input:visible").evaluateAll((wrappers) =>
    wrappers.map((wrapper) => {
      const input = wrapper.querySelector("input")!;
      const icon = wrapper.querySelector("svg")!;
      const b = input.getBoundingClientRect();
      return {
        name: input.name || input.placeholder,
        gap: b.x + parseFloat(getComputedStyle(input).paddingLeft) - icon.getBoundingClientRect().right,
      };
    }),
  );
  for (const input of inputs) assert.ok(input.gap >= 5, `${input.name}: text overlaps icon (${input.gap}px)`);
}

async function checkLayout(page: Page, name: string) {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    clipped: [
      ...document.querySelectorAll<HTMLElement>(
        ".login-card, .login-note, .page, .toolbar, .page-header, .project-header, .kpi-grid, .risk-tiles, .overview-charts, .drawer, .drawer-body, .report-preview",
      ),
    ]
      .filter((el) => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 2)
      .map((el) => ({ selector: el.className, overflow: el.scrollWidth - el.clientWidth })),
  }));
  layouts.push({ name, ...result });
  if (result.overflow > 1 || result.clipped.length) {
    layoutFailures.push({ name, ...result });
    await page.screenshot({ path: join(output, `issue-${name.replaceAll("/", "-")}.png`), fullPage: true });
  }
  await checkIconInputs(page);
}

async function goRoute(page: Page, route: string) {
  const key = route.split("/").pop()!;
  const selector =
    key === "blackboard"
      ? ".board-layout"
      : `.page-${key === "tasks" ? "timeline" : key === "overview" ? "project-overview" : key}`;
  await page.evaluate((route) => {
    location.hash = `#/${route}`;
  }, route);
  await page.locator(selector).waitFor();
  await page.locator(".page-skeleton, .settings-skeleton").waitFor({ state: "hidden" });
}

async function checkWorkspaceReviewQueue(page: Page) {
  const paused = store.create(
    createProjectSchema.parse({
      title: "暂停项目的待审核发现",
      origin: "https://example.test",
      goal: "Verify waiting review state",
    }),
  ).project.id;
  store.submitFinding(
    paused,
    findingSchema.parse({ title: "暂停后等待审核的发现", description: "Synthetic candidate" }),
  );
  store.mutate(paused, "fixture.paused-review", false, (graph) => {
    graph.project.status = "stopped";
  });
  store.mutate(id, "fixture.zero-vulnerabilities", false, (graph) => {
    graph.findings.find((finding) => finding.id === "finding_pass")!.withdrawn_at = new Date().toISOString();
    graph.findings[0].review_worker = "frontend-reviewer";
  });
  await goRoute(page, "security");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".sync-dot"));
  const library = page.locator(".sidebar .nav-item").filter({ hasText: /^漏洞库/ });
  assert.equal(
    await library.innerText(),
    "漏洞库",
    "Zero confirmed vulnerabilities have neither a count nor a pending dot",
  );
  assert.equal(await library.locator(".nav-dot, [data-pending], .nav-meta").count(), 0);
  const total = store.overview().totals.pending_review;
  const kpi = page.locator(".page-security .kpi").filter({ hasText: "待审核" });
  assert.equal(await kpi.locator(".kpi-value").innerText(), String(total));
  await page.getByText(`${total} 条漏洞待审核`, { exact: true }).first().waitFor();
  await kpi.click();
  await page.locator(".page-reviews").waitFor();
  assert.equal(new URL(page.url()).hash, "#/reviews");
  assert.equal(await page.locator(".workspace-review-row").count(), total);
  const filters = page.getByRole("group", { name: "审核队列筛选" });
  await filters.getByRole("button", { name: "正在审核 1", exact: true }).click();
  assert.equal(await page.locator(".workspace-review-row").count(), 1);
  await page.getByRole("button", { name: /查看 .* 的审核进度/ }).click();
  await page.locator(".page-review").waitFor();
  assert.equal(
    await page
      .locator(".sidebar .nav-item")
      .filter({ hasText: /^审核队列/ })
      .locator(".nav-count")
      .innerText(),
    String(pendingReviews(store.get(id)).length),
    "Project navigation uses only its own queue",
  );
  await goRoute(page, "reviews");
  await filters.getByRole("button", { name: `等待中 ${total - 1}`, exact: true }).click();
  await page.getByLabel("筛选审核项目").selectOption(paused);
  assert.equal(await page.locator(".workspace-review-row").count(), 1);
  await page.getByText("项目已暂停或完成", { exact: true }).waitFor();
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, `workspace-reviews-${width}`);
    await page.screenshot({ path: join(output, `reviews-${width}.png`), fullPage: true });
  }
  await page.getByLabel("搜索待审核发现").fill("no-match");
  await page.getByText("没有匹配的待审核发现", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  store.mutate(id, "fixture.restore-vulnerabilities", false, (graph) => {
    delete graph.findings.find((finding) => finding.id === "finding_pass")!.withdrawn_at;
    delete graph.findings[0].review_worker;
  });
  await goRoute(page, "security");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".sync-dot"));
  await page.screenshot({ path: join(output, "security-dark-1440.png"), fullPage: true });
}

async function checkFindingReviews(page: Page) {
  const labels = ["全部", "未审核", "审核通过", "待补证据", "已驳回"];
  const titles = [
    ["合成候选发现", "合成通过发现", "合成驳回发现", "合成待补证发现", "合成修订待复审", "合成信息类发现"],
    ["合成候选发现", "合成修订待复审"],
    ["合成通过发现", "合成信息类发现"],
    ["合成待补证发现"],
    ["合成驳回发现"],
  ];
  async function rows(selector: string, expected: string[]) {
    await page.waitForFunction(
      ({ selector, expected }) => {
        const actual = [...document.querySelectorAll(selector)].map((el) => el.textContent?.trim()).sort();
        return JSON.stringify(actual) === JSON.stringify([...expected].sort());
      },
      { selector, expected },
    );
  }

  await goRoute(page, `projects/${id}/findings`);
  const projectFilters = page.getByRole("group", { name: "发现审核筛选", exact: true });
  const gradeTabs = page.getByRole("group", { name: "按严重程度分级", exact: true });
  await projectFilters.getByRole("button", { name: "全部 6", exact: true }).click();
  // 页面按危险度分级：页签先给出各等级计数，列表再按等级分节，信息类单独一节。
  assert.deepEqual(await gradeTabs.locator("button b").allInnerTexts(), ["6", "1", "1", "4", "1"]);
  assert.deepEqual(await page.locator(".finding-group-name").allInnerTexts(), ["高危", "中危", "信息类"]);
  assert.deepEqual(
    await projectFilters.locator("button").allTextContents(),
    labels.map((label, i) => `${label} ${titles[i].length}`),
  );
  for (let i = 0; i < labels.length; i++) {
    await projectFilters.getByRole("button", { name: `${labels[i]} ${titles[i].length}`, exact: true }).click();
    await rows(".finding-item-title", titles[i]);
  }
  await projectFilters.getByRole("button", { name: "待补证据 1", exact: true }).click();
  assert.equal(
    await page.locator('[data-finding="finding_needs_evidence"] .status-pill').getAttribute("data-tone"),
    "warn",
  );
  await projectFilters.getByRole("button", { name: "未审核 2", exact: true }).click();
  assert.equal(await page.locator('[data-finding="finding_revised"] .status-pill').innerText(), "未审核");
  assert.equal(await page.locator('[data-finding="finding_revised"] .finding-warn').count(), 1);
  assert.equal(
    await page.locator(`.finding-item[data-finding="${store.get(id).findings[0].id}"] .finding-warn`).count(),
    0,
  );
  await projectFilters.getByRole("button", { name: "全部 6", exact: true }).click();
  await gradeTabs.getByRole("button", { name: /^高危/ }).click();
  await rows(".finding-item-title", ["合成通过发现"]);
  assert.deepEqual(await projectFilters.locator("button").allTextContents(), [
    "全部 1",
    "未审核 0",
    "审核通过 1",
    "待补证据 0",
    "已驳回 0",
  ]);
  await projectFilters.getByRole("button", { name: "已驳回 0", exact: true }).click();
  await rows(".finding-item-title", []);
  await gradeTabs.getByRole("button", { name: /^全部/ }).click();
  await rows(".finding-item-title", ["合成驳回发现"]);
  await page.screenshot({ path: join(output, "findings-review-rejected.png"), fullPage: true });

  await goRoute(page, "vulns");
  await rows(".vuln-table .cell-title", ["合成通过发现"]);
  assert.equal(await page.getByRole("group", { name: "按审核状态筛选", exact: true }).count(), 0);
  await page.getByLabel("搜索漏洞", { exact: true }).fill("合成待补证");
  await rows(".vuln-table .cell-title", []);
  await page.getByRole("button", { name: "重置筛选", exact: true }).first().click();
  await rows(".vuln-table .cell-title", ["合成通过发现"]);
  await page.screenshot({ path: join(output, "vulns-confirmed-only.png"), fullPage: true });
  // 项目之前停留在「已驳回」，从漏洞库打开通过项仍应选中目标。
  await page.locator(".vuln-table .cell-title").filter({ hasText: "合成通过发现" }).click();
  await page.locator('[data-finding="finding_pass"][data-active]').waitFor();
  assert.equal(
    await projectFilters.getByRole("button", { name: "全部 6", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await gradeTabs.getByRole("button", { name: /^信息类/ }).click();
  await rows(".finding-item-title", ["合成信息类发现"]);
  // 信息类不是危险度等级：切到这一页签后只保留单独的一节。
  assert.deepEqual(await page.locator(".finding-group-name").allInnerTexts(), ["信息类"]);
  await page.locator(".fd-verdict").getByText("信息类", { exact: true }).waitFor();
  assert.equal(await page.locator(".fd-verdict").getByText("信息类", { exact: true }).count(), 1);
  assert.equal(await page.locator(".fd-cvss").count(), 0);
  await gradeTabs.getByRole("button", { name: /^全部/ }).click();
  await page.getByLabel("发现保留状态", { exact: true }).selectOption("withdrawn");
  await rows(".finding-item-title", ["合成已撤回发现"]);
  await page.getByLabel("发现保留状态", { exact: true }).selectOption("active");
  await checkLayout(page, "findings-review-filters");
}

async function checkCausalProvenance(page: Page) {
  await goRoute(page, `projects/${id}/blackboard`);
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.locator(".graph-canvas").evaluate((el, factId) => {
    const cy = (el as unknown as { _cyreg: { cy: { getElementById(id: string): { emit(event: string): void } } } })
      ._cyreg.cy;
    cy.getElementById(factId).emit("tap");
  }, observation.id);
  const detail = page.locator(".detail-panel .detail-content");
  await detail.getByText("生产来源", { exact: true }).waitFor();
  assert.ok((await detail.innerText()).includes("Run：未记录"), "manual observations do not invent a Run");
  assert.equal(await detail.locator(".source-links").getByRole("button", { name: step.id, exact: true }).count(), 1);
  await checkLayout(page, "fact-provenance");
  await page.screenshot({ path: join(output, "fact-provenance.png"), fullPage: true });
  await detail.locator(".source-links").getByRole("button", { name: step.id, exact: true }).click();
  await detail.getByText("产出事实", { exact: true }).waitFor();
  await goRoute(page, `projects/${id}/findings`);
  await page.getByRole("button", { name: /^报告(?:\d+)?$/ }).click();
  await page.getByRole("button", { name: "生成报告", exact: true }).click();
  await page.locator(".report-row").first().getByRole("button", { name: "预览", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "报告网页预览", exact: true });
  await preview.getByText("因果溯源", { exact: true }).first().click();
  assert.ok((await preview.innerText()).includes(`${step.id} → ${observation.id}（生产事实`));
  assert.ok((await preview.innerText()).includes("origin →"));
  await checkLayout(page, "report-causal-trace");
  await page.screenshot({ path: join(output, "report-causal-trace.png"), fullPage: true });
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await preview.boundingBox();
    assert.ok(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      "report drawer stays within the viewport",
    );
    await checkLayout(page, `report-causal-trace-${width}`);
  }
  await page.screenshot({ path: join(output, "report-causal-trace-mobile.png"), fullPage: true });
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function checkSearchCompletion(page: Page) {
  const project = store.create(
    createProjectSchema.parse({
      title: "搜索与审核完成验收",
      origin: "https://example.test",
      goal: "验证搜索结束仍可审核",
    }),
  );
  const pid = project.project.id;
  const evidence = store.addEvidence(pid, {
    title: "完成验收原件",
    content: "synthetic proof",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    pid,
    findingSchema.parse({ ...reportFields, title: "待审核结论", description: "合成声明", evidence_ids: [evidence.id] }),
  );
  const reviewer = store.claim(pid, "completion-reviewer", Number.MAX_SAFE_INTEGER)!;
  const planner = store.claim(pid, "completion-planner", 0)!,
    read = store.get(pid);
  store.submitDecisions(
    pid,
    submitDecisionsSchema.parse({
      worker: planner.worker,
      submission_id: "frontend-complete",
      revision: read.revision,
      observation_revision: read.observation_revision,
      planning_revision: read.planning_revision,
      complete: { from: ["origin"], description: "搜索已结束，已有结论待审核" },
    }),
    planner.run_id,
  );
  await goRoute(page, `projects/${pid}/overview`);
  await page.getByText("搜索结束、审核中。当前发现审核结束后完成交付。", { exact: true }).waitFor();
  assert.equal(store.claim(pid, "extra-planner", 0), null);
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, `search-ended-reviewing-${width}`);
  }
  await page.screenshot({ path: join(output, "search-ended-reviewing-mobile.png"), fullPage: true });
  store.review(
    pid,
    finding.id,
    reviewSchema.parse({
      worker: reviewer.worker,
      finding_version: 1,
      kind: "vulnerability",
      verdict: "pass",
      reason: "合成证据核对完成",
      cvss: withImpactEvidence(cvss.high, [evidence.id]),
    }),
  );
  assert.equal(store.get(pid).project.status, "completed");
  assert.equal(store.claim(pid, "after-pass", 0), null);
  await page.reload();
  await page.getByText("探索已结束，可回查结论和证据。", { exact: true }).waitFor();
  await goRoute(page, `projects/${pid}/review`);
  // 审核通过后面紧跟结论分类，用文字而不是图标：图标在窄屏与深色下只剩一个符号。
  const kindTag = page
    .locator(".review-card-head .tag")
    .filter({ hasText: /^漏洞类$/ })
    .first();
  await kindTag.waitFor();
  assert.equal((await kindTag.innerText()).trim(), "漏洞类", "Vulnerability classification is written out as text");
  assert.equal(
    await page.getByRole("img", { name: "漏洞类", exact: true }).count(),
    0,
    "Review cards do not use a vulnerability icon",
  );
  await goRoute(page, `projects/${pid}/overview`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkLayout(page, "search-delivery-completed");
}

async function checkProjectMenus(page: Page) {
  const menu = page.getByRole("menu", { name: "更多项目操作", exact: true });
  async function assertMenu(name: string) {
    await menu.waitFor();
    const geometry = await menu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        insideViewport: box.left >= 8 && box.top >= 8 && box.right <= innerWidth - 7 && box.bottom <= innerHeight - 7,
        portal: element.parentElement === document.body,
        visibleItems: [...element.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => {
          const rect = item.getBoundingClientRect();
          return item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }),
      };
    });
    assert.equal(geometry.insideViewport, true, `${name}: menu stays within the viewport`);
    assert.equal(geometry.portal, true, `${name}: menu escapes clipping and stacking contexts`);
    assert.deepEqual(geometry.visibleItems, [true, true, true], `${name}: every action is visible and clickable`);
    await page.screenshot({ path: join(output, `project-menu-${name}.png`), fullPage: true });
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: 720 });
      await goRoute(page, `projects/${id}/overview`);
      const trigger = page.locator(".topbar-tools .project-more-trigger");
      await trigger.click();
      await assertMenu(`topbar-${theme}-${width}`);
      await page.keyboard.press("End");
      assert.equal(
        await menu
          .getByRole("menuitem", { name: "删除项目", exact: true })
          .evaluate((item) => item === document.activeElement),
        true,
      );
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await menu
          .getByRole("menuitem", { name: "导出项目数据", exact: true })
          .evaluate((item) => item === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(await menu.count(), 0);
      assert.equal(
        await trigger.evaluate((button) => button === document.activeElement),
        true,
        "Escape restores focus to the trigger",
      );
      await trigger.press("ArrowUp");
      await menu.getByRole("menuitem", { name: "删除项目", exact: true }).waitFor();
      assert.equal(
        await menu
          .getByRole("menuitem", { name: "删除项目", exact: true })
          .evaluate((item) => item === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      await trigger.click();
      await page.locator(".breadcrumb .crumb.current").click();
      assert.equal(await menu.count(), 0, "Clicking outside closes the menu");

      await goRoute(page, "projects");
      const row = page.locator(".projects-table tbody tr").filter({ hasText: graph.project.title });
      await row.getByRole("button", { name: "更多项目操作", exact: true }).click();
      await assertMenu(`list-${theme}-${width}`);
      await page.locator(".content").evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollTop - 24);
      });
      await assertMenu(`list-scroll-${theme}-${width}`);
      await page.keyboard.press("Escape");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await goRoute(page, `projects/${id}/overview`);
  await page.getByRole("button", { name: "更多项目操作", exact: true }).click();
  await menu.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "项目操作", exact: true });
  await rename.getByRole("heading", { name: "重命名项目", exact: true }).waitFor();
  assert.equal(await menu.count(), 0, "Choosing an action closes the menu");
  await rename.getByRole("button", { name: "取消", exact: true }).click();
}

async function checkDeletionHistory(page: Page) {
  const job = store.claim(id, "frontend-decider", 0)!,
    current = store.get(id);
  const result = store.submitDecisions(
    id,
    submitDecisionsSchema.parse({
      worker: job.worker,
      submission_id: "frontend-delete",
      revision: current.revision,
      observation_revision: current.observation_revision,
      planning_revision: current.planning_revision,
      delete_nodes: [{ id: observation.id, reason: "此观测已不属于当前工作图，保留原文用于追溯" }],
    }),
    job.run_id,
  );
  assert.equal(result.settle.ok, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await goRoute(page, `projects/${id}/blackboard`);
  await page.reload();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.getByRole("button", { name: "删除历史 1", exact: true }).waitFor();
  const hasFact = await page.locator(".graph-canvas").evaluate((el, factId) => {
    const cy = (el as unknown as { _cyreg: { cy: { getElementById(id: string): { length: number } } } })._cyreg.cy;
    return !!cy.getElementById(factId).length;
  }, observation.id);
  assert.equal(hasFact, false, "deleted Fact leaves the current graph");
  assert.ok(!(await page.locator("main").innerText()).includes(observation.description));
  await page.getByRole("button", { name: "删除历史 1", exact: true }).click();
  await page.getByRole("button", { name: `读取历史 ${observation.id}`, exact: true }).click();
  const history = page.getByRole("dialog", { name: "节点历史", exact: true });
  await history.getByText("此观测已不属于当前工作图，保留原文用于追溯", { exact: true }).waitFor();
  assert.ok((await history.innerText()).includes(observation.description));
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, `deleted-node-history-${width}`);
    await page.screenshot({ path: join(output, `deleted-node-history-${width}.png`), fullPage: true });
  }
  await history.getByRole("button", { name: "关闭面板", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  // A retained Finding keeps its pass and links explicitly to the removed source.
  await page.locator(".graph-canvas").evaluate((el) => {
    const cy = (el as unknown as { _cyreg: { cy: { getElementById(id: string): { emit(event: string): void } } } })
      ._cyreg.cy;
    cy.getElementById("finding_pass").emit("tap");
  });
  await page
    .locator(".detail-panel")
    .getByRole("button", { name: `${observation.id} · 已删除`, exact: true })
    .click();
  await history.getByText("此观测已不属于当前工作图，保留原文用于追溯", { exact: true }).waitFor();
  await history.getByRole("button", { name: "关闭面板", exact: true }).click();
  assert.equal(store.get(id).findings.find((f) => f.id === "finding_pass")!.review_status, "pass");
}

/** 黑板光晕画在一张独立的 canvas 上，坐标来自 renderedBoundingBox（容器 CSS px）。
 *  canvas 是替换元素：只写 inset 时宽高取位图自身尺寸，DPR > 1 就会让光晕按位图尺寸
 *  放大、与节点错位。150% 缩放下断言画布盒与容器盒一致，位图只按倍率变大。
 *  这个 context 本身就是 reduced-motion，正好回归「系统减少动态效果不能静默关掉动效」。 */
async function checkMotionOverlay(page: Page) {
  const motion = page.locator(".graph-particles");
  const toggle = page.getByRole("button", { name: /(?:开启|关闭)黑板动效/ });
  assert.equal(
    await toggle.getAttribute("aria-pressed"),
    "true",
    "黑板动效应默认开启，并由工具栏开关而不是系统 reduced-motion 决定",
  );
  await page.locator(".graph-canvas").evaluate((el) => {
    const cy = (
      el as unknown as {
        _cyreg: { cy: { nodes(): { slice(a: number, b: number): { data(k: string, v: string): void }[] } } };
      }
    )._cyreg.cy;
    for (const node of cy.nodes().slice(0, 2)) node.data("state", "running");
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".graph-particles")?.dataset.motionState === "running",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(120);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(120);
  assert.equal(
    await motion.getAttribute("data-motion-state"),
    "running",
    "系统开启「减少动态效果」后，黑板动效仍应保持开启并继续绘制",
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await page.waitForTimeout(400);
  const box = await page.evaluate(() => {
    const host = document.querySelector(".graph-canvas")!,
      overlay = document.querySelector<HTMLCanvasElement>(".graph-particles")!;
    const hostBox = host.getBoundingClientRect(),
      overlayBox = overlay.getBoundingClientRect();
    return {
      host: [hostBox.width, hostBox.height],
      overlay: [overlayBox.width, overlayBox.height],
      bitmap: [overlay.width, overlay.height],
      ratio: Math.min(2, devicePixelRatio || 1),
    };
  });
  assert.ok(box.host[0] > 100 && box.host[1] > 100, "光晕画布应覆盖真实的黑板舞台");
  assert.equal(box.ratio, 1.5, "设备缩放模拟应生效，否则这条断言会空转");
  assert.ok(
    Math.abs(box.host[0] - box.overlay[0]) < 1 && Math.abs(box.host[1] - box.overlay[1]) < 1,
    `150% 缩放下光晕画布应与图容器同尺寸：容器 ${box.host.join("×")}，画布 ${box.overlay.join("×")}`,
  );
  assert.deepEqual(
    box.bitmap,
    [Math.round(box.overlay[0] * box.ratio), Math.round(box.overlay[1] * box.ratio)],
    "画布位图应按 DPR 放大，而不是改变 CSS 盒尺寸",
  );
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await page.emulateMedia({ reducedMotion: "reduce" });
}

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TESSERA_BROWSER_BIN ? { executablePath: process.env.TESSERA_BROWSER_BIN } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  // Keep the real EventSource contract, with a controllable stream for burst tests.
  await context.addInitScript(() => {
    const streams: EventTarget[] = [];
    Object.assign(window, { __refreshStreams: streams });
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        streams.push(this);
      }
      close() {
        streams.splice(streams.indexOf(this), 1);
      }
    } as unknown as typeof EventSource;
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.listeningOrigin);
  await page.locator(".login-card").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const loginScripts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((r) => r.name.endsWith(".js"))
      .map((r) => ({ name: r.name.split("/").pop(), bytes: (r as PerformanceResourceTiming).decodedBodySize })),
  );
  assert.ok(
    loginScripts.reduce((total, script) => total + script.bytes, 0) < 300_000,
    "Login must not load workspace/graph code",
  );
  assert.ok(loginScripts.every((script) => !/App-|Board-|AssetMap-|cytoscape/.test(script.name!)));
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("tessera.theme", theme);
    }, theme);
    for (const width of [320, 375, 768, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await checkLayout(page, `login-${theme}-${width}`);
      if (width > 1080) await checkLogo(page);
      if (width === 375 || width === 1440)
        await page.screenshot({ path: join(output, `login-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.getByRole("textbox", { name: "用户名" }).fill("frontend-test");
  await page.locator('input[name="password"]').fill("wrong-password");
  await page.locator('.login-card button[type="submit"]').click();
  await page.locator(".login-error").waitFor();
  assert.equal(await page.locator('input[name="password"]').inputValue(), "");
  await page.locator('input[name="password"]').fill("frontend-fixture-password");
  await page.locator('.login-card button[type="submit"]').click();
  await page.locator(".app").waitFor();
  await page.locator(".page-security .kpi-grid").waitFor();
  await checkLogo(page);
  assert.equal(
    await page.evaluate(() =>
      performance.getEntriesByType("resource").some((r) => /cytoscape|Board-|AssetMap-/.test(r.name)),
    ),
    false,
    "Workspace overview must not load graph libraries",
  );

  let projectRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/projects")) projectRequests++;
  });
  // A delayed request also covers refresh events arriving while a refresh is running.
  await page.route("**/api/projects", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  const burst = () =>
    page.evaluate(() => {
      const streams = (window as unknown as { __refreshStreams: EventTarget[] }).__refreshStreams;
      for (let i = 0; i < 25; i++) streams.forEach((stream) => stream.dispatchEvent(new Event("refresh")));
    });
  await burst();
  await page.waitForRequest((request) => request.url().endsWith("/api/projects"));
  await burst();
  await page.waitForFunction(() => !document.querySelector(".sync-dot"));
  await page.waitForTimeout(650);
  assert.equal(projectRequests, 2, "Two bursts, including one in flight, must produce two refreshes");
  const burstProjectRequests = projectRequests;
  await page.unroute("**/api/projects");

  await checkWorkspaceReviewQueue(page);
  await checkFindingReviews(page);
  await checkCausalProvenance(page);
  await checkSearchCompletion(page);
  await checkProjectMenus(page);

  store.mutate(id, "fixture.review-queue", false, (g) => {
    g.findings[0].kind = "vulnerability";
    const candidate = g.findings[0];
    g.findings.push(
      { ...candidate, id: "v1000", title: "后领取的发现" },
      { ...candidate, id: "v999", title: "先领取的发现" },
      { ...candidate, id: "v998", title: "等待来源任务", revision_step_id: "missing-step" },
      { ...candidate, id: "v997", title: "等待批准", asset_id: "unapproved" },
      { ...candidate, id: "v996", title: "等待退避", retry_at: new Date(Date.now() + 60000).toISOString() },
    );
  });
  await goRoute(page, `projects/${id}/review`);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator("#pending-review-v999").waitFor();
  const pendingKind = page.locator("#pending-review-v999 .tag").filter({ hasText: /^漏洞类$/ });
  await pendingKind.waitFor();
  assert.equal((await pendingKind.innerText()).trim(), "漏洞类");
  const queue = await page.locator(".review-pending-row").evaluateAll((rows) => rows.map((row) => row.id));
  assert.ok(queue.indexOf("pending-review-v999") < queue.indexOf("pending-review-v1000"));
  assert.ok(queue.indexOf("pending-review-v1000") < queue.indexOf("pending-review-v998"));
  for (const [finding, label] of [
    ["v998", "等待执行结束"],
    ["v997", "等待资产批准"],
    ["v996", "等待重试"],
  ])
    assert.ok((await page.locator(`#pending-review-${finding}`).innerText()).includes(label));

  const routes = [
    "security",
    "projects",
    "vulns",
    "reviews",
    "settings",
    ...[
      "overview",
      "findings",
      "review",
      "assets",
      "tasks",
      "timeline",
      "traffic",
      "evidence",
      "files",
      "blackboard",
    ].map((route) => `projects/${id}/${route}`),
  ];
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await goRoute(page, route);
      if (route.endsWith("blackboard")) await page.locator(".graph-canvas canvas").first().waitFor();
      await page.waitForTimeout(60);
      await checkLayout(page, `${route}-${width}`);
      if (width === 1440 && route.endsWith("overview")) await checkSidebar(page, "dark");
      if (route.endsWith("assets")) {
        await page.getByRole("button", { name: "资产星图", exact: true }).click();
        await page.locator(".asset-map-canvas canvas").first().waitFor();
        await checkLayout(page, `asset-map-${width}`);
        await page.getByRole("button", { name: "列表", exact: true }).click();
      }
      if (route.endsWith("blackboard") && width === 1440) {
        for (const layout of ["dagre_lr", "klay_tb", "klay_lr", "elk_tb", "elk_lr", "dagre_tb"]) {
          await page.getByLabel("图布局", { exact: true }).selectOption(layout);
          await page.locator(`.graph-canvas[data-layout-ready="${layout}"]`).waitFor();
          assert.equal(await page.locator(".graph-layout [role='alert']").count(), 0);
        }
        await checkMotionOverlay(page);
      }
      if (width === 375 && /security$|overview$|blackboard$|projects$|settings$|reviews?$/.test(route))
        await page.screenshot({ path: join(output, `${route.split("/").pop()}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "浅色主题", exact: true }).click();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await goRoute(page, route);
      await page.waitForTimeout(60);
      await checkLayout(page, `light-${route}-${width}`);
      if (width === 1440 && /^(security|projects|reviews)$/.test(route))
        await page.screenshot({ path: join(output, `${route}-light-${width}.png`), fullPage: true });
      if (width === 1440 && route.endsWith("overview")) await checkSidebar(page, "light");
    }
  }
  await checkDeletionHistory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    location.hash = "#/projects";
  });
  await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
  await page.locator(".search-input input").fill("不会命中的项目");
  await page.getByText("没有匹配的项目", { exact: true }).waitFor();
  await page.locator(".search-input input").fill("");
  await page.getByRole("button", { name: "折叠侧栏" }).click();
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
  assert.ok(
    await page.locator(".sidebar .new-project span").first().isVisible(),
    "Mobile navigation restores collapsed desktop labels",
  );
  await page.screenshot({ path: join(output, "navigation-mobile.png"), fullPage: true });
  await checkLogo(page);
  await page.getByRole("button", { name: "关闭导航", exact: true }).first().click();
  await page.getByRole("button", { name: "新建项目", exact: true }).last().click();
  await page.getByRole("dialog").waitFor();
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    assert.ok(
      await page.getByRole("dialog").evaluate((dialog) => dialog.contains(document.activeElement)),
      "Tab stays inside the create dialog",
    );
  }
  await checkLayout(page, "create-modal-mobile");
  await page.screenshot({ path: join(output, "create-mobile.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "搜索页面、项目与发现", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "命令面板", exact: true });
  await palette.getByRole("textbox").fill("no-matching-results");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  assert.ok(
    await palette.evaluate((dialog) => dialog.contains(document.activeElement)),
    "Empty search keeps keyboard focus inside the palette",
  );
  await page.keyboard.press("Escape");
  assert.equal(await palette.count(), 0);
  await page.reload();
  await page.locator(".app").waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "light",
    "Saved theme is applied before entering the workspace",
  );
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.locator(".login-card").waitFor();
  assert.deepEqual(errors, [], "Uncaught browser errors");
  assert.deepEqual(layoutFailures, [], "Clipped or overflowing content");
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify({ loginScripts, burstProjectRequests, layouts, errors }, null, 2),
  );
  console.log(JSON.stringify({ status: "ok", loginScripts, burstProjectRequests, layouts: layouts.length, output }));
} catch (failure) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: join(output, "failure.png"), fullPage: true });
  throw failure;
} finally {
  writeFileSync(join(output, "layout-report.json"), JSON.stringify({ layouts, layoutFailures, errors }, null, 2));
  await browser?.close();
  await app.close();
  store.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith("tessera-frontend-"));
  rmSync(dir, { recursive: true, force: true });
}
