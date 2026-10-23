// 原版工作台操作的浏览器回归。
// 覆盖工作台主要交互：项目创建（多个初始 Hint）、
// 项目列表数量与运行提示、暂停全部、重命名、删除确认、完成后 Reopen、
// YAML/时间线预览与复制/下载、Origin/Goal/Fact/未知方向圆节点、线状态样式、
// 点击连线定位 Step、多 Fact 选择与移除、关联子图（只看连得上的节点）、六种层级布局、缩放/平移/适应/导出图片、
// 声明 Step、Claim/Heartbeat/Release/Conclude、人工完成、优先级与废弃、
// Hint/Goal/Finding 快速列表、Finding 人工 Confirm/Reject、时间线定位与回放控制、
// 本地 Actor/默认布局/详情宽度、心跳超时设置。
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.TESSERA_QA_URL || "http://127.0.0.1:8787";
// 内部接口（jobs/claim、fgs/*/execute…）需要 Worker 凭据：跑 QA 时把同一凭据传给脚本即可。
const workerToken = process.env.TESSERA_WORKER_TOKEN || "";
async function api(url, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + "/api" + url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(workerToken ? { "x-tessera-worker-token": workerToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function status(url) {
  return (
    await fetch(base + "/api" + url, {
      headers: workerToken ? { "x-tessera-worker-token": workerToken } : {},
    })
  ).status;
}
// 登录门（TESSERA_AUTH=off 时不会出现登录卡片）。
const operatorUser = process.env.TESSERA_OPERATOR_USER || "operator";
const operatorPassword = process.env.TESSERA_OPERATOR_PASSWORD || "";
async function signIn(page) {
  await page.waitForSelector('.login-card input[name="username"], .app');
  if (!(await page.locator('.login-card input[name="username"]').count())) return;
  assert.ok(operatorPassword, "服务端启用了登录门，请设置 TESSERA_OPERATOR_PASSWORD");
  for (let attempt = 0; attempt < 14; attempt++) {
    await page.locator('.login-card input[name="username"]').fill(operatorUser);
    await page.locator('.login-card input[name="password"]').fill(operatorPassword);
    await page.locator('.login-card button[type="submit"]').click();
    try {
      // 前几次失败可能触发服务端限流（30 秒），重试等待解锁。
      await page.locator(".app").waitFor({ timeout: 3000 });
      return;
    } catch {
      await page.waitForTimeout(3000);
    }
  }
  throw new Error("无法登录：服务端持续拒绝操作员凭据");
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TESSERA_BROWSER_BIN
      ? { executablePath: process.env.TESSERA_BROWSER_BIN }
      : {}),
  });
  let project, context;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await signIn(page);
    const cyEval = (fn, arg) => page.locator(".graph-canvas").evaluate(fn, arg);
    // 画布浮动控件（缩放工具条 / 布局下拉 / 图例）不得互相压住
    const noOverlap = async (a, b, label) => {
      const [ra, rb] = await Promise.all([
        page.locator(a).boundingBox(),
        page.locator(b).boundingBox(),
      ]);
      assert.ok(ra && rb, `${label} 应同时存在`);
      const clash = !(
        ra.y + ra.height <= rb.y ||
        rb.y + rb.height <= ra.y ||
        ra.x + ra.width <= rb.x ||
        rb.x + rb.width <= ra.x
      );
      assert.equal(clash, false, `${label} 不应重叠`);
    };

    // 本地 Actor、默认布局与服务心跳超时（原版：本地偏好 + Step/Decide 超时设置）
    await page
      .getByRole("button", { name: "本地偏好与心跳设置" })
      .click();
    await page.getByLabel("Actor").fill("QA 人工");
    await page.getByLabel("默认布局").selectOption("klay_lr");
    await page.getByLabel("Step 心跳超时（秒）").fill("131");
    await page.getByLabel("Decide 心跳超时（秒）").fill("97");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("dialog", { name: "本地偏好" })
      .waitFor({ state: "detached" });
    const settings = await api("/settings");
    assert.equal(settings.intent_timeout, 131);
    assert.equal(settings.reason_timeout, 97);

    // 新建项目：起点、目标、多个初始 Hint（可增可删）
    await page
      .getByRole("button", { name: "新建项目", exact: true })
      .first()
      .click();
    await page
      .getByLabel("项目名称", { exact: true })
      .fill("浏览器验收 · 工作台");
    await page.getByLabel("指定站点 / 起始信息").fill("https://example.test");
    await page
      .getByLabel("目标", { exact: true })
      .fill("验证可复现发现，并覆盖独立方向");
    await page.getByRole("button", { name: "+ 添加", exact: true }).click();
    await page.getByRole("button", { name: "+ 添加", exact: true }).click();
    await page
      .getByLabel("初始 Hint 1", { exact: true })
      .fill("首个初始 hint：优先确认登录入口");
    await page
      .getByLabel("初始 Hint 2", { exact: true })
      .fill("第二个初始 hint：提交前删除");
    await page
      .getByLabel("初始 Hint 3", { exact: true })
      .fill("第三个初始 hint：保留");
    await page.getByLabel("移除初始 Hint 2", { exact: true }).click();
    await page.getByLabel("完成策略").selectOption("assessment");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    // 新 IA：项目落地页是概览，黑板是页签之一
    await page.locator(".risk-tiles").waitFor();
    assert.ok(
      (await page.locator(".risk-tiles .risk-tile").count()) === 6,
      "概览应显示各等级及未定级风险统计",
    );
    fs.mkdirSync("test-results", { recursive: true });
    assert.equal(await page.locator(".usage-footer").count(), 0);
    await page.getByRole("button", { name: "查看项目用量", exact: true }).click();
    await page.getByRole("dialog", { name: "项目用量", exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭面板", exact: true }).click();
    await page.screenshot({
      path: "test-results/overview-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "黑板", exact: true }).click();
    await page.locator(".graph-canvas").waitFor();
    project = (await api("/projects")).find(
      (p) => p.title === "浏览器验收 · 工作台",
    );
    assert.ok(project);
    const p = "/projects/" + project.id;
    let graph = await api(p);
    assert.deepEqual(
      graph.hints.map((h) => h.content),
      ["首个初始 hint：优先确认登录入口", "第三个初始 hint：保留"],
    );
    assert.ok(
      graph.hints.every((h) => h.creator === "QA 人工"),
      "初始 Hint 应记录本地 Actor",
    );

    await api(p + "/jobs/claim", { worker: "qa-planner", debounce_ms: 0 });
    await page.locator(".graph-decision-state").waitFor();
    assert.equal(await page.locator(".graph-decision-scan").count(), 1);
    await page.screenshot({ path: "test-results/blackboard-decide-scan.png", fullPage: false });
    graph = await api(p);
    await api(p + "/fgs/decisions", {
      submission_id: "browser-initial-plan",
      worker: "qa-planner",
      revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      steps: [
        {
          from: ["origin"],
          description: "识别站点入口与登录流程",
          priority: 2,
        },
        { from: ["origin"], description: "检查独立的文件接口", priority: 1 },
      ],
      goals: [{ description: "理解账号与资源之间的权限关系" }],
    });
    const job = await api(p + "/jobs/claim", {
      worker: "qa-executor",
      debounce_ms: 0,
    });
    // 预置多条证据：验证可滚动列表不被 flex 压缩（曾出现条目被压成 32px、文字与下一行重叠）
    for (let i = 0; i < 14; i++)
      await api(p + "/evidence", {
        title: `工具输出 ${i + 1}`,
        step_id: job.step_id,
        content: `tool line ${i}\n`.repeat(60),
        mime_type: "text/plain",
      });
    const evidence = await api(p + "/evidence", {
      title: "HTTP 请求与响应",
      step_id: job.step_id,
      content: "GET /api/profile\nHTTP 200\nAccount: test-user",
      mime_type: "text/plain",
    });
    await api(p + "/fgs/steps/" + job.step_id + "/execute", {
      worker: job.worker,
      facts: [
        {
          description: "站点提供登录后的资源接口",
          evidence_ids: [evidence.id],
        },
        "浏览器状态保存在 /workspace/browser-state.json",
      ],
      findings: [
        {
          title: "资源身份边界候选",
          description: "需要第二个测试身份复现访问结果",
          evidence_ids: [evidence.id],
        },
      ],
      summary: "登录后的入口已确认；可继续验证权限关系。",
    });
    const assets = await api(p + "/assets", {
      assets: [
        { hostname: "api.example.test", source: "公开域名记录" },
        { hostname: "staging.example.test", source: "站点链接" },
      ],
    });

    // 补充 Hint 使用本地 Actor
    await page
      .getByLabel("补充 Hint")
      .fill("已有两个测试账号，优先检查资源权限。");
    await page.getByRole("button", { name: "添加 Hint" }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.hints.some((h) => h.creator === "QA 人工");
      },
      base + "/api" + p,
    );

    // 子域名批准
    await page
      .getByRole("button", { name: "资产与范围", exact: false })
      .first()
      .click();
    await page
      .getByRole("button", { name: "批准测试", exact: true })
      .first()
      .waitFor();
    graph = await api(p);
    assert.equal(graph.steps.length, 2);
    await page
      .getByRole("button", { name: "批准测试", exact: true })
      .first()
      .click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.steps.length === 3;
      },
      base + "/api" + p,
    );
    graph = await api(p);
    assert.equal(
      graph.assets.find((a) => a.id === assets[0].id).approval,
      "approved",
    );

    await page.getByRole("button", { name: "资产星图", exact: true }).click();
    await page.locator(".asset-map-canvas").waitFor();
    await page.getByRole("button", { name: "收起资产详情", exact: true }).click();
    assert.equal(await page.locator(".asset-map-detail").isVisible(), false);
    await page.getByRole("button", { name: "展开资产详情", exact: true }).click();
    await page.waitForFunction(count => document.querySelector(".asset-map-canvas")?._cyreg?.cy?.nodes('[type="asset"]').length === count, graph.assets.length);
    await page.locator(".asset-map-canvas").evaluate((el, id) => { el._cyreg.cy.getElementById(id).emit("tap"); }, assets[0].id);
    await page.locator(".asset-map-detail").getByRole("heading", { name: assets[0].hostname }).waitFor();
    await page.screenshot({ path: "test-results/assets-star-map.png", fullPage: true });
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await page.getByRole("button", { name: /^任务/ }).click();
    await page.getByRole("tab", { name: "运行记录", exact: true }).click();
    await page.getByRole("region", { name: "持久运行记录" }).waitFor();
    await page.getByRole("tab", { name: "任务列表", exact: true }).click();
    await page.getByLabel("搜索任务", { exact: true }).fill(job.step_id);
    // 只数任务列表里的行：运行记录面板复用了 .task-row 样式，不属于任务列表
    assert.equal(await page.locator(".tasks-list .tasks-row").count(), 1);
    await page.getByRole("button", { name: "查看任务与结果", exact: true }).click();
    await page.locator(".detail-panel .node-id").getByText(job.step_id, { exact: true }).waitFor();
    await page.getByRole("button", { name: "搜索项目记录", exact: true }).click();
    const searchAlignment = await page.locator(".record-search .search-field").evaluate(el => {
      const icon = el.querySelector("svg").getBoundingClientRect(), input = el.querySelector("input").getBoundingClientRect();
      return { centerGap: Math.abs(icon.y + icon.height / 2 - input.y - input.height / 2), separated: icon.right <= input.left };
    });
    assert.ok(searchAlignment.centerGap < 2 && searchAlignment.separated, "搜索图标应与输入框同排居中且不重叠");
    await page.screenshot({ path: "test-results/project-search.png", fullPage: false });
    await page.getByLabel("搜索 ID 或关键词").fill("h001");
    await page.locator(".search-results button").first().click();
    await page.locator(".detail-panel .node-id").getByText("h001", { exact: true }).waitFor();
    await page.getByRole("button", { name: "任务与运行", exact: true }).click();
    assert.equal(await page.getByLabel("搜索任务", { exact: true }).inputValue(), job.step_id);

    await page.getByRole("button", { name: "黑板", exact: true }).click();
    await page.locator(".graph-canvas").waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".graph-canvas")?._cyreg?.cy?.nodes().length >=
        8,
    );
    await page.waitForFunction(() => {
      const c = document.querySelector(".graph-canvas")._cyreg.cy;
      return (
        c.getElementById("origin").length === 1 &&
        c.getElementById("goal").length === 1
      );
    });

    // 未知方向圆节点与线状态样式：执行结束仍是待关闭；只有决策者关闭后才是 concluded 实线
    const marks = await cyEval((el) => {
      const c = el._cyreg.cy,
        step = c.$('node[type="step"]').eq(0),
        concluded = c.$('edge[status="concluded"]').eq(0),
        open = c.$('edge[status="open"]').eq(0),
        goal = c.getElementById("goal");
      return {
        steps: c.$('node[type="step"]').length,
        executedSteps: c.$('node[type="step"][state="executed"]').length,
        stepShape: step.length ? step.style("shape") : null,
        stepLabel: step.length ? step.data("label") : null,
        concluded: concluded.length
          ? {
              line: concluded.style("line-style"),
              color: concluded.style("line-color"),
            }
          : null,
        open: open.length
          ? { line: open.style("line-style"), color: open.style("line-color") }
          : null,
        goalEdges: c.$('edge[target="goal"]').length,
        goalState: goal.data("state"),
        goalBorder: goal.style("border-style"),
        goalColor: goal.style("border-color"),
        scopeNodes: c.$('node[type="scope"]').length,
        scopeLinks: c.$('edge[type="scope-link"]').length,
      };
    });
    assert.ok(marks.steps >= 1, "未完成 Step 应显示为圆节点");
    assert.equal(marks.stepShape, "ellipse");
    assert.equal(marks.stepLabel, "?");
    assert.ok(marks.executedSteps >= 1, "执行结束但未关闭的 Step 应以 executed 状态留在入口");
    assert.equal(marks.concluded, null, "未关闭前不应有 concluded 连线");
    assert.equal(marks.open?.line, "dashed");
    // 未达成最终目标前不对 Goal 连任何线：目标只用虚线边框表示「还没达成」。
    assert.equal(marks.goalEdges, 0, "未达成目标前不应有任何指向 Goal 的连线");
    assert.equal(marks.goalState, "open");
    assert.equal(marks.goalBorder, "dashed");
    // 批准的子域名是「范围」节点，与 Origin 同层并挂在它下面，而不是假装成某次探索的发现。
    assert.ok(marks.scopeNodes >= 1, "批准的子域名应显示为范围节点");
    assert.ok(marks.scopeLinks >= 1, "范围节点应从 Origin 得到一条批准连线");
    // v3：主视图点选只做选中，不改变画布范围（不缩成子图、不重排）
    const nodesBeforeSelect = await cyEval((el) => el._cyreg.cy.nodes().length);
    await cyEval(el => { el._cyreg.cy.getElementById("f001").emit("tap"); });
    await page.locator(".detail-panel .node-id").getByText("f001", { exact: true }).waitFor();
    const afterSelect = await cyEval((el) => ({
      nodes: el._cyreg.cy.nodes().length,
      selected: el._cyreg.cy.$("node.selected").map((n) => n.id()),
      scope: !!document.querySelector(".graph-scope"),
    }));
    assert.equal(afterSelect.scope, false, "主视图点选不应切换成链路视图");
    assert.equal(afterSelect.nodes, nodesBeforeSelect, "主视图点选不应改变节点数量");
    assert.deepEqual(afterSelect.selected, ["f001"], "点选应标记选中节点");

    // 显式入口：详情面板「只看这条链路」= 从起点追到结论的那一条线
    await page.getByRole("button", { name: "只看这条链路", exact: true }).click();
    await page.locator(".graph-scope").waitFor();
    await page.waitForFunction(() => document.querySelector(".graph-canvas")?.dataset.layoutReady === "dagre_tb");
    assert.equal(await page.getByLabel("图布局").inputValue(), "dagre_tb", "链路默认有序层级布局");
    assert.equal(await page.locator('.graph-layout option[value="compact"]').count(), 0);
    assert.equal(await page.locator(".graph-layout-note").count(), 0);
    const chained = await cyEval((el) => {
      const c = el._cyreg.cy;
      const ids = new Set(c.nodes().map((n) => n.id()));
      return {
        nodes: c.nodes().length,
        edges: c.edges().length,
        dangling: c.edges().filter((e) => !ids.has(e.source().id()) || !ids.has(e.target().id())).length,
        dimmed: c.$("node.dimmed").length,
        hasOrigin: ids.has("origin"),
        text: document.querySelector(".graph-scope")?.textContent || "",
      };
    });
    assert.equal(chained.dangling, 0, "链路视图不应有悬空边");
    assert.equal(chained.dimmed, 0, "v3 不再用「变暗的全图」表达范围");
    assert.ok(chained.nodes < nodesBeforeSelect, "链路视图应小于全图");
    assert.equal(chained.hasOrigin, true, "链路应一路追到起点 Origin");
    assert.match(chained.text, /节点 · \d+ 连线/, "范围条应给出节点与连线数量");
    // 链路内可以独立点选节点：切换选中不退出链路，也不需要重新进入。
    const innerId = await cyEval((el) => el._cyreg.cy.nodes().filter((n) => n.data("type") !== "finding").eq(0).id());
    await cyEval((el, id) => { el._cyreg.cy.getElementById(id).emit("tap"); }, innerId);
    await page.waitForFunction(
      (id) => document.querySelector(".graph-canvas")._cyreg.cy.$("node.selected").map((n) => n.id()).join() === id,
      innerId,
    );
    assert.equal(await page.locator(".graph-scope").count(), 1, "链路内点选不应退出链路视图");
    const keptScope = await cyEval((el) => ({ scope: el.dataset.scope, nodes: el._cyreg.cy.nodes().length }));
    assert.equal(keptScope.scope, "chain");
    assert.equal(keptScope.nodes, chained.nodes, "链路内点选不应改变画布范围");
    await page.screenshot({ path: "test-results/blackboard-chain.png", fullPage: false });
    await page.locator(".graph-scope").getByRole("button", { name: "显示全图" }).click();
    await page.locator(".graph-scope").waitFor({ state: "detached" });
    await page.waitForFunction(
      (count) => document.querySelector(".graph-canvas")._cyreg.cy.nodes().length === count,
      nodesBeforeSelect,
    );

    // 只给真实运行中的任务和路径动效；动效默认开启。拖动时暂停装饰，但实时图不隐藏。
    await api(p + "/intents/s002/heartbeat", { worker: "qa-motion" });
    await page.waitForFunction(() => Number(document.querySelector(".graph-particles")?.dataset.activeNodes) > 0);
    await page.getByRole("button", { name: "关闭黑板动效", exact: true }).waitFor();
    await cyEval(el => { const c = el._cyreg.cy; c.panBy({ x: 12, y: 8 }); });
    assert.equal(await page.locator(".graph-particles").getAttribute("data-motion-state"), "paused");
    await page.waitForFunction(() => document.querySelector(".graph-particles").dataset.motionState === "running");
    const motionColor = await page.locator(".graph-particles").getAttribute("data-motion-color");
    await page.screenshot({ path: "test-results/blackboard-running-light.png", animations: "disabled" });
    await page.getByTitle("切换主题", { exact: true }).click();
    await page.waitForFunction(color => document.querySelector(".graph-particles")?.dataset.motionColor !== color, motionColor);
    await page.screenshot({ path: "test-results/blackboard-running-dark.png", animations: "disabled" });
    await page.getByTitle("切换主题", { exact: true }).click();
    // Windows 关闭「动画效果」、远程桌面或虚拟机都会命中 reduced-motion；它不能静默关掉黑板动效。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(150);
    assert.equal(
      await page.locator(".graph-particles").getAttribute("data-motion-state"),
      "running",
      "系统减少动态效果不应暂停黑板动效",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.deepEqual(await cyEval(el => { const options = el._cyreg.cy.json(); return { hidden: options.hideEdgesOnViewport, texture: options.textureOnViewport }; }), { hidden: false, texture: false });
    const movingNode = await cyEval(el => {
      const n = el._cyreg.cy.getElementById("s002"), p = n.renderedPosition(), r = el.getBoundingClientRect();
      return { x: r.x + p.x, y: r.y + p.y, model: { ...n.position() } };
    });
    await page.mouse.move(movingNode.x, movingNode.y); await page.mouse.down();
    await page.mouse.move(movingNode.x + 24, movingNode.y + 16, { steps: 8 });
    const duringDrag = await cyEval(el => {
      const n = el._cyreg.cy.getElementById("s002");
      return { grabbed: n.grabbed(), position: n.position(), visibleEdges: n.connectedEdges().every(e => e.visible()) };
    });
    assert.equal(duringDrag.grabbed, true);
    assert.notDeepEqual(duringDrag.position, movingNode.model, "节点位置在松开鼠标前已实时更新");
    assert.equal(duringDrag.visibleEdges, true);
    await page.screenshot({ path: "test-results/blackboard-during-drag.png", animations: "disabled" });
    await page.mouse.up();
    await api(p + "/intents/s002/release", { worker: "qa-motion" });
    await page.waitForFunction(() => document.querySelector(".graph-particles")?.dataset.motionState === "idle");
    const boardSnapshot = () => cyEval(el => ({ zoom: el._cyreg.cy.zoom(), pan: el._cyreg.cy.pan(), selected: el._cyreg.cy.$("node.selected").map(n => n.id()), positions: el._cyreg.cy.nodes().map(n => ({ id: n.id(), position: n.position() })).sort((a, b) => a.id.localeCompare(b.id)) }));
    const rememberedBoard = await boardSnapshot();
    await page.getByRole("button", { name: "概览", exact: true }).click();
    await page.getByRole("button", { name: "黑板", exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector(".graph-canvas")?.dataset.layoutReady);
    const returnedBoard = await boardSnapshot();
    assert.deepEqual(returnedBoard, rememberedBoard, "普通页面跳转应完整保留黑板视角、选中与节点位置");
    await page.getByRole("button", { name: "收起黑板详情", exact: true }).click();
    assert.equal(await page.locator(".detail-panel").isVisible(), false);
    await page.getByRole("button", { name: "展开黑板详情", exact: true }).click();
    await page.getByRole("button", { name: "关闭黑板动效", exact: true }).click();
    await page.getByRole("button", { name: "开启黑板动效", exact: true }).waitFor();
    await cyEval(el => { el._cyreg.cy.emit("tap"); });
    await page.locator(".graph-scope").waitFor({ state: "detached" });

    // 画布浮动控件互不遮挡（曾出现布局下拉被缩放工具条压住）
    await noOverlap(".graph-toolbar", ".graph-layout", "缩放工具条与布局下拉");
    await noOverlap(".graph-layout", ".graph-legend", "布局下拉与图例");
    await noOverlap(".graph-toolbar", ".graph-legend", "缩放工具条与图例");
    assert.ok(
      (await page.locator(".graph-layout").boundingBox()).x >
        (await page.locator(".graph-toolbar").boundingBox()).x + 200,
      "布局下拉应位于画布右侧",
    );

    // 图缩放、适应、平移、导出图片
    const zoomBefore = await cyEval((el) => el._cyreg.cy.zoom());
    await page.getByRole("button", { name: "放大黑板" }).click();
    const zoomIn = await cyEval((el) => el._cyreg.cy.zoom());
    assert.ok(zoomIn > zoomBefore);
    await page.getByRole("button", { name: "缩小黑板" }).click();
    assert.ok((await cyEval((el) => el._cyreg.cy.zoom())) < zoomIn);
    await page.getByRole("button", { name: "适应黑板" }).click();
    const panBefore = await cyEval((el) => {
      const p = el._cyreg.cy.pan();
      return { x: p.x, y: p.y };
    });
    const box = await page.locator(".graph-canvas").boundingBox();
    // 从画布右下角（避开左上工具条与左下图例）拖动
    const startX = box.x + box.width - 70,
      startY = box.y + box.height - 60;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 90, startY - 60, { steps: 8 });
    await page.mouse.up();
    const panAfter = await cyEval((el) => {
      const p = el._cyreg.cy.pan();
      return { x: p.x, y: p.y };
    });
    assert.ok(
      Math.abs(panAfter.x - panBefore.x) > 1 ||
        Math.abs(panAfter.y - panBefore.y) > 1,
      "拖动应平移黑板",
    );
    const [shot] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出黑板图片" }).click(),
    ]);
    assert.match(shot.suggestedFilename(), /\.png$/);

    for (const layout of [
      "dagre_tb",
      "dagre_lr",
      "klay_tb",
      "klay_lr",
      "elk_tb",
      "elk_lr",
    ]) {
      await page.getByLabel("图布局").selectOption(layout);
      await page.waitForFunction(
        (value) =>
          document.querySelector(".graph-canvas")?.dataset.layoutReady ===
          value,
        layout,
      );
      assert.equal(await page.locator(".graph-layout [role=alert]").count(), 0);
    }
    await page.getByLabel("图布局").selectOption("dagre_lr");
    await page.waitForFunction(
      () =>
        document.querySelector(".graph-canvas")?.dataset.layoutReady ===
        "dagre_lr",
    );

    // 点击连线定位到对应 Step
    const edge = await page.locator(".graph-canvas").evaluate((el) => {
      const c = el._cyreg.cy;
      let best = null,
        bestLen = 0;
      c.edges()
        .filter((e) => e.data("step_id") && e.visible())
        .forEach((e) => {
          const s = e.source().renderedPosition(),
            t = e.target().renderedPosition(),
            m = e.renderedMidpoint(),
            len = Math.hypot(t.x - s.x, t.y - s.y);
          if (len > bestLen) {
            bestLen = len;
            best = { step: e.data("step_id"), x: m.x, y: m.y };
          }
        });
      if (!best) return null;
      const r = el.getBoundingClientRect();
      return { step: best.step, x: r.x + best.x, y: r.y + best.y };
    });
    assert.ok(edge, "应存在可点击的连线");
    await page.mouse.click(edge.x, edge.y);
    let edgeHit = await page
      .waitForFunction(
        (id) => document.querySelector(".node-id")?.textContent?.trim() === id,
        edge.step,
        { timeout: 2500 },
      )
      .then(() => true)
      .catch(() => false);
    if (!edgeHit) {
      await page.locator(".graph-canvas").evaluate((el, step) => {
        el._cyreg.cy
          .edges()
          .filter((e) => e.data("step_id") === step)
          .eq(0)
          .emit("tap");
      }, edge.step);
      edgeHit = await page
        .waitForFunction(
          (id) =>
            document.querySelector(".node-id")?.textContent?.trim() === id,
          edge.step,
          { timeout: 2500 },
        )
        .then(() => true)
        .catch(() => false);
      console.log("注意：连线定位通过程序化 tap 验证，鼠标命中未生效。");
    }
    assert.ok(edgeHit, "点击连线应定位到对应 Step");

    const position = await page.locator(".graph-canvas").evaluate((el) => {
      const cy = el._cyreg.cy,
        n = cy.getElementById("s002"),
        p = n.renderedPosition(),
        r = el.getBoundingClientRect();
      return { x: r.x + p.x, y: r.y + p.y };
    });
    await page.mouse.click(position.x, position.y);
    await page.getByLabel("Step 优先级").waitFor();
    await page.getByLabel("Step 优先级").fill("7");
    await page.getByLabel("Step 优先级").blur();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.steps.find((s) => s.id === "s002").priority === 7;
      },
      base + "/api" + p,
    );
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/blackboard-desktop.png",
      fullPage: true,
    });
    assert.equal(await page.locator(".board-area > .workbench-tools").count(), 0, "旧人工操作条不常驻画布");
    await page.getByRole("button", { name: "人工干预", exact: true }).click();
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await page
      .getByRole("button", { name: "Heartbeat", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Heartbeat", exact: true }).click();
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await page.getByRole("button", { name: "Claim", exact: true }).waitFor();
    await page.getByRole("button", { name: "Conclude", exact: true }).click();
    await page
      .getByLabel("发现了什么事实？")
      .fill("人工确认该接口返回测试身份的信息");
    await page
      .getByRole("dialog", { name: "黑板操作" })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return !!g.steps.find((s) => s.id === "s002").concluded_at;
      },
      base + "/api" + p,
    );
    // 人工重开 / 关闭：直接验证这轮新增的决策入口，而不是只靠模型 Decide。
    const manualDrawer = page.getByRole("dialog", { name: "人工干预", exact: true });
    await manualDrawer.getByRole("button", { name: "重开任务", exact: true }).click();
    const reopenDialog = page.getByRole("dialog", { name: "重开任务", exact: true });
    await reopenDialog.getByLabel("理由").fill("QA 复核：原关闭理由不成立");
    await reopenDialog.getByRole("button", { name: "确认重开", exact: true }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        const s = g.steps.find((x) => x.id === "s002");
        return !!s && !s.concluded_at && !s.executed_at && s.close_reason === undefined;
      },
      base + "/api" + p,
    );
    await manualDrawer.getByRole("button", { name: "关闭任务", exact: true }).click();
    const closeDialog = page.getByRole("dialog", { name: "关闭任务", exact: true });
    await closeDialog.getByLabel("理由").fill("QA 复核：答案已足够");
    await closeDialog.getByRole("button", { name: "确认关闭", exact: true }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        const s = g.steps.find((x) => x.id === "s002");
        return !!s && !!s.concluded_at && s.close_reason === "QA 复核：答案已足够";
      },
      base + "/api" + p,
    );
    await page.getByRole("dialog", { name: "人工干预", exact: true }).getByRole("button", { name: "关闭面板" }).click();
    // 关闭是决策者的动作：只有 conclude 之后才出现 concluded 实线，且不与目标绿同色。
    const concludedEdge = await cyEval(el => {
      const c = el._cyreg.cy, edge = c.$('edge[status="concluded"]').eq(0);
      return edge.length ? { line: edge.style("line-style"), color: edge.style("line-color"),
        goalColor: c.getElementById("goal").style("border-color") } : null;
    });
    assert.equal(concludedEdge?.line, "solid", "决策者关闭后连线变为 concluded 实线");
    assert.notEqual(concludedEdge?.color, concludedEdge?.goalColor, "已完成连线不应使用目标的绿色");

    async function clickNode(nid, additive = false) {
      // 画布可能在一次点击与下一次点击之间重排（关联子图收敛/新增节点），
      // 因此点击后要确认真的选中了；未命中就重新测量再点一次。
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForFunction(() => !!document.querySelector(".graph-canvas")?.dataset.layoutReady);
        const pos = await page.locator(".graph-canvas").evaluate((el, id) => {
          const n = el._cyreg.cy.getElementById(id),
            p = n.renderedPosition(),
            r = el.getBoundingClientRect();
          return { x: r.x + p.x, y: r.y + p.y };
        }, nid);
        if (additive) await page.keyboard.down("Shift");
        await page.mouse.click(pos.x, pos.y);
        if (additive) await page.keyboard.up("Shift");
        const hit = await page.locator(".graph-canvas").evaluate((el, id) => {
          const n = el._cyreg.cy.getElementById(id);
          return n.hasClass("selected-fact") || n.hasClass("selected");
        }, nid);
        if (hit) return;
        await page.waitForTimeout(200);
      }
      throw new Error(`点击节点 ${nid} 未命中`);
    }
    const selectedFacts = () =>
      cyEval((el) => {
        const c = el._cyreg.cy;
        const ids = new Set(c.nodes().map((n) => n.id()));
        return {
          selected: c.$("node.selected-fact").length,
          dimmed: c.$("node.dimmed").length,
          dangling: c.edges().filter((e) => !ids.has(e.source().id()) || !ids.has(e.target().id())).length,
          scoped: !!document.querySelector(".graph-scope"),
          nodes: c.nodes().length,
        };
      });

    // 多 Fact 选择：只做选中与移除，主视图范围不变（v3 不再用变暗表达范围）
    await cyEval((el) => { el._cyreg.cy.emit("tap"); });
    await page.locator(".graph-scope").waitFor({ state: "detached" });
    const fullNodes = await cyEval((el) => el._cyreg.cy.nodes().length);
    await clickNode("origin");
    await clickNode("f001", true);
    const mark = await selectedFacts();
    assert.equal(mark.selected, 2);
    assert.equal(mark.dimmed, 0, "v3 不再用变暗表达范围");
    assert.equal(mark.dangling, 0, "不应出现悬空边");
    assert.equal(mark.scoped, false, "主视图多选不应切换成链路视图");
    assert.equal(mark.nodes, fullNodes, "主视图多选不应改变节点数量");
    await page.getByRole("button", { name: "人工干预", exact: true }).click();
    await page.getByRole("button", { name: "移除已选事实 f001" }).click();
    await page.waitForFunction(
      () => document.querySelector(".graph-canvas")._cyreg.cy.$("node.selected-fact").length === 1,
    );
    await page.getByRole("dialog", { name: "人工干预", exact: true }).getByRole("button", { name: "关闭面板" }).click();
    await clickNode("f001", true);
    await page.waitForFunction(
      () => document.querySelector(".graph-canvas")._cyreg.cy.$("node.selected-fact").length === 2,
    );

    await page.getByRole("button", { name: "人工干预", exact: true }).click();
    await page.getByRole("button", { name: "声明 Step", exact: true }).click();
    await page.getByLabel("准备探索什么？").fill("基于两个已选事实继续验证");
    await page.getByRole("button", { name: "声明并领取", exact: true }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.steps.some((s) => s.from.length === 2 && s.worker === "QA 人工");
      },
      base + "/api" + p,
    );
    await page.getByRole("dialog", { name: "人工干预", exact: true }).getByRole("button", { name: "关闭面板" }).click();

    // YAML / 时间线预览、复制、下载
    await page.getByRole("button", { name: "更多项目操作", exact: true }).click();
    assert.equal(await page.locator(".top-actions > a").count(), 0, "顶栏不再常驻重复的导出入口");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("menu", { name: "更多项目操作", exact: true }).count(), 0);
    await page.getByRole("button", { name: "更多项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出项目数据", exact: true }).click();
    assert.equal(await page.getByRole("dialog", { name: "导出预览" }).evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 20);
      return el.parentElement.parentElement === document.body && el.contains(top) && rect.bottom <= innerHeight;
    }), true, "YAML 弹窗应位于顶层且完整显示在视口内");
    await page
      .locator(".export-preview")
      .filter({ hasText: "origin" })
      .waitFor();
    await page.getByRole("button", { name: "复制", exact: true }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /origin/);
    const [yaml] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "下载", exact: true }).click(),
    ]);
    assert.match(yaml.suggestedFilename(), /\.yaml$/);
    await page.locator(".export-tabs").getByRole("button", { name: "时间线", exact: true }).click();
    await page
      .locator(".export-preview")
      .filter({ hasText: "project.created" })
      .waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    // 时间线定位 + 回放：播放/暂停、重启、速度、退出
    await page.locator(".detail-tabs").getByRole("button", { name: /黑板时间线/ }).click();
    await page.locator(".timeline-event").first().click();
    await page.locator(".replay-bar").waitFor();
    // 回放只移动选中并居中：画布必须一直是总视图，不能在播放中跳进单条链路。
    await page.waitForFunction(() => document.querySelector(".graph-canvas")?.dataset.scope === "all");
    assert.equal(await page.locator(".graph-scope").count(), 0, "回放应保持总视图，不切链路");
    assert.ok((await page.locator(".replay-bar").boundingBox()).height <= 44, "回放栏保持紧凑单行");
    await page.waitForFunction(
      () =>
        document.querySelector(".graph-canvas")?._cyreg?.cy.$("node.selected")
          .length >= 1,
    );
    // 回放展示有序的完整链路，选中节点应可见，不强行把终点居中而裁掉起点。
    await page.waitForFunction(() => {
      const el = document.querySelector(".graph-canvas"),
        c = el._cyreg.cy,
        n = c.$("node.selected").eq(0);
      if (n.length !== 1) return false;
      const p = n.renderedPosition();
      return (
        p.x >= 0 && p.x <= el.clientWidth &&
        p.y >= 0 && p.y <= el.clientHeight
      );
    });
    const toggle = page
      .locator(
        '.replay-bar button[aria-label="暂停回放"], .replay-bar button[aria-label="播放回放"]',
      )
      .first();
    const toggleBefore = await toggle.getAttribute("aria-label");
    await toggle.click();
    await page.waitForFunction(
      (before) =>
        document.querySelector(".replay-bar button")?.getAttribute("aria-label") !==
        before,
      toggleBefore,
    );
    await page.getByLabel("回放速度").selectOption("550");
    const replayed = Number(
      await page.locator('[aria-label="回放位置"]').inputValue(),
    );
    await page.getByRole("button", { name: "重启回放" }).click();
    await page.waitForFunction(
      (before) =>
        Number(
          document.querySelector('[aria-label="回放位置"]')?.value ?? before,
        ) < before,
      Math.max(replayed, 1),
    );
    // 退出回放入口就在回放条内（且全局只有这一个）
    assert.equal(
      await page.getByRole("button", { name: "回到实时" }).count(),
      1,
      "回到实时 应只有一个入口",
    );
    const exitReplay = page
      .locator(".replay-bar")
      .getByRole("button", { name: "回到实时" });
    await exitReplay.waitFor();
    await exitReplay.click();
    await page.locator(".replay-bar").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "发现", exact: true }).click();
    await page.getByRole("heading", { name: "资源身份边界候选" }).waitFor();
    const allFindings = await page.locator(".finding-card").count();
    await page.getByRole("button", { name: /^已审核 / }).click();
    const reviewedFindings = await page.locator(".finding-card").count();
    await page.getByRole("button", { name: /^未审核 / }).click();
    const pendingFindings = await page.locator(".finding-card").count();
    assert.equal(reviewedFindings + pendingFindings, allFindings, "审核筛选应覆盖全部发现且不重叠");
    await page.getByRole("button", { name: /^全部 / }).click();
    assert.equal(await page.locator(".finding-card").count(), allFindings);
    await page.locator(".finding-card").first().getByRole("button", { name: "查看发现链路", exact: true }).click();
    await page.locator(".graph-scope").waitFor();
    await page.waitForFunction(() => document.querySelector(".graph-canvas")?.dataset.layoutReady === "dagre_tb");
    const discovery = await cyEval(el => {
      const c = el._cyreg.cy;
      return { hasOrigin: !!c.getElementById("origin").length, tasks: c.nodes('[type="step"]').length,
        selectedType: c.nodes(".selected").data("type"), ordered: c.edges().every(e => e.source().position("y") < e.target().position("y")) };
    });
    assert.ok(discovery.hasOrigin && discovery.tasks > 0, "漏洞链路包含起点与实际执行任务");
    assert.equal(discovery.selectedType, "finding");
    assert.equal(discovery.ordered, true, "漏洞链路从上到下按因果顺序排列");
    await page.screenshot({ path: "test-results/finding-discovery-chain.png", animations: "disabled" });
    await page.getByRole("button", { name: "证据", exact: true }).click();
    // 证据列表：条目高度不得被压缩，内容不得溢出到下一行
    assert.ok(
      (await page.locator(".evidence-index-item").count()) >= 12,
      "应列出多条证据",
    );
    const squeeze = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".evidence-index-item")];
      const heights = rows.map((b) => Math.round(b.getBoundingClientRect().height));
      return {
        min: Math.min(...heights),
        overflow: rows.filter((b) => b.scrollHeight > b.clientHeight + 1).length,
      };
    });
    assert.ok(squeeze.min >= 44, `证据条目不应被压缩（实测最小 ${squeeze.min}px）`);
    assert.equal(squeeze.overflow, 0, "证据条目内容不应溢出");
    await page.locator(".evidence-index-item").first().click();
    await page
      .locator(".evidence-pre")
      .filter({ hasText: "GET /api/profile" })
      .waitFor();
    await page.getByRole("button", { name: "审核", exact: true }).click();
    await page.getByText("等待审核 Worker").waitFor();

    // Finding 人工 Reject / Confirm，保留两次审核记录
    await page.getByRole("button", { name: "黑板", exact: true }).click();
    // 提示 / 目标 / 发现三个快速面板：长文本必须换行，不能撑出面板横向溢出
    for (const tab of ["^提示 Hints", "^目标 Goals", "^发现 Findings"]) {
      await page.getByRole("button", { name: new RegExp(tab) }).click();
      await page.locator(".quick-content").waitFor();
      const overflow = await page.evaluate(() => {
        const box = document.querySelector(".quick-content");
        const items = [...document.querySelectorAll(".quick-item")];
        return {
          panel: box.scrollWidth - box.clientWidth,
          widest: Math.max(0, ...items.map(item => item.scrollWidth - item.clientWidth)),
          items: items.length,
        };
      });
      assert.ok(overflow.panel <= 1, `${tab} 面板内容横向溢出 ${overflow.panel}px`);
      assert.ok(overflow.widest <= 1, `${tab} 条目标题横向溢出 ${overflow.widest}px`);
    }
    // 发现面板在上一轮循环里已经打开
    const quick = page.locator(".quick-content .quick-item").first();
    await quick.getByRole("button", { name: "Reject", exact: true }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.findings[0]?.status === "rejected";
      },
      base + "/api" + p,
    );
    await quick.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.findings[0]?.status === "confirmed" && g.reviews.length >= 2;
      },
      base + "/api" + p,
    );
    graph = await api(p);
    assert.deepEqual(
      graph.reviews.map((r) => r.verdict),
      ["rejected", "pass"],
    );
    await page.locator(".sidebar").getByRole("button", { name: "时间线", exact: true }).click();
    await page.getByRole("heading", { name: "时间线", exact: true }).waitFor();
    const auditAlignment = await page.locator(".timeline-audit").evaluate(el => {
      const input = el.querySelector("input").getBoundingClientRect(), label = el.querySelector("span").getBoundingClientRect();
      return { gap: Math.abs(input.y + input.height/2 - label.y - label.height/2), separated: input.right < label.left };
    });
    assert.ok(auditAlignment.gap < 2 && auditAlignment.separated, "归档/用量复选框应与文字同排对齐");
    assert.ok(await page.locator(".timeline-row").count() > 0);
    await page.getByRole("button", { name: "发现与审核", exact: true }).click();
    assert.ok(await page.locator(".timeline-row").count() >= graph.reviews.length);
    await page.screenshot({ path: "test-results/project-timeline.png", fullPage: true });
    // 时间线作为独立项目入口；任务页只保留任务与运行记录。
    const activityTab = await context.newPage();
    activityTab.setDefaultTimeout(15000);
    await activityTab.goto(`${base}/#${p}/timeline`);
    await activityTab.getByRole("heading", { name: "时间线", exact: true }).waitFor();
    assert.equal(await activityTab.locator(".sidebar").getByRole("button", { name: "时间线", exact: true }).getAttribute("aria-current"), "page");
    await activityTab.locator(".sidebar").getByRole("button", { name: "任务与运行", exact: true }).click();
    await activityTab.getByRole("tab", { name: "运行记录", exact: true }).click();
    await activityTab.getByRole("region", { name: "持久运行记录" }).waitFor();
    await activityTab.getByRole("tab", { name: "运行记录", exact: true }).focus();
    await activityTab.keyboard.press("Home");
    await activityTab.getByLabel("搜索任务", { exact: true }).waitFor();
    await activityTab.emulateMedia({ reducedMotion: "reduce" });
    await activityTab.screenshot({ path: "test-results/moonlight-activity-light.png", animations: "disabled" });
    await activityTab.getByTitle("切换主题", { exact: true }).click();
    await activityTab.screenshot({ path: "test-results/moonlight-activity-dark.png", animations: "disabled" });
    const darkColors = await activityTab.locator(".tasks-row").first().evaluate(el => ({
      background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, theme: document.documentElement.dataset.theme,
    }));
    assert.equal(darkColors.theme, "dark");
    assert.notEqual(darkColors.background, darkColors.text);
    await activityTab.setViewportSize({ width: 390, height: 844 });
    await activityTab.screenshot({ path: "test-results/moonlight-activity-mobile.png", animations: "disabled" });
    assert.equal(await activityTab.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await activityTab.close();
    await page.getByRole("button", { name: "概览", exact: true }).click();
    await page.locator(".sidebar").getByRole("button", { name: "时间线", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "发现与审核", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "全部进展", exact: true }).click();
    await page.getByRole("button", { name: "回放此刻", exact: true }).first().click();
    await page.locator(".replay-bar").waitFor();
    await page.getByRole("button", { name: "回到实时", exact: true }).click();
    await page.getByRole("button", { name: "审核", exact: true }).click();
    const reviewLink = page.locator(".review-card .evidence-link").last();
    await reviewLink.waitFor();
    const returnPosition = await page.locator(".content").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    await reviewLink.click();
    await page.getByRole("button", { name: "返回审核", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回审核", exact: true }).click();
    await page.getByRole("heading", { name: "证据审核", exact: true }).waitFor();
    await page.waitForFunction((expected) => Math.abs(document.querySelector(".content").scrollTop - expected) < 3, returnPosition);
    assert.equal(await page.getByRole("dialog", { name: "证据预览" }).count(), 0);
    await page.getByRole("button", { name: "黑板", exact: true }).click();

    // 项目暂停 / 继续
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.getByRole("button", { name: "继续", exact: true }).waitFor();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await page.reload();
    await page.locator(".graph-canvas").waitFor();
    assert.ok(page.url().includes(project.id));

    // 本地偏好与详情宽度持久化
    const prefs = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("tessera.localPrefs")),
    );
    assert.equal(prefs.actor_name, "QA 人工");
    assert.equal(prefs.layout_mode, "dagre_lr");
    await page.getByLabel("调整详情面板宽度").focus();
    await page.keyboard.press("ArrowLeft");
    const panelWidth = await page.evaluate(() =>
      localStorage.getItem("tessera.sidePanelWidth"),
    );
    assert.ok(Number(panelWidth) > 0);
    await page.reload();
    await page.locator(".detail-panel").waitFor();
    assert.equal(
      await page
        .locator(".detail-panel")
        .evaluate((el) => el.style.getPropertyValue("--detail-panel-width")),
      panelWidth + "px",
    );

    // Step 废弃（选择 Step 后废弃该方向）
    graph = await api(p);
    const open = graph.steps.find(
      (s) => s.description === "基于两个已选事实继续验证" && !s.concluded_at,
    );
    assert.ok(open, "应存在人工声明的 Step（暂停会释放租约，故不校验 worker）");
    await page.waitForFunction(
      (id) =>
        !!document
          .querySelector(".graph-canvas")
          ?._cyreg?.cy.getElementById(id).length,
      open.id,
    );
    await clickNode(open.id);
    await page.getByRole("button", { name: "废弃这个方向" }).click();
    await page
      .getByLabel("废弃理由")
      .fill("重复路径：已有其他方向覆盖同一入口");
    await page.screenshot({
      path: "test-results/discard-reason.png",
      fullPage: false,
    });
    await page
      .getByRole("dialog", { name: "废弃这个方向" })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return !!g.steps.find((s) => s.discarded);
      },
      base + "/api" + p,
    );
    graph = await api(p);
    assert.equal(
      graph.steps.find((s) => s.id === open.id).discard_reason,
      "重复路径：已有其他方向覆盖同一入口",
    );
    await page.getByText("重复路径：已有其他方向覆盖同一入口").waitFor();

    // 人工完成项目后从界面 Reopen（继续评估）
    await api(p + "/complete", {
      from: ["origin"],
      description: "人工确认目标已满足",
      worker: "QA 人工",
    });
    await page.reload();
    await page.getByRole("button", { name: "继续评估", exact: true }).click();
    await page
      .getByLabel("继续探索的原因")
      .fill("出现新的验证方向，需要恢复探索");
    await page
      .getByRole("dialog", { name: "继续评估" })
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.waitForFunction(
      async (url) => {
        const g = await (await fetch(url)).json();
        return g.project.status === "active";
      },
      base + "/api" + p,
    );

    // 提示优先级、编辑、撤回可从详情页操作，撤回保留历史。
    const hintRecord = await api(p + "/hints", { content: "浏览器提示生命周期", priority: 3 });
    const hintId = hintRecord.id;
    await page.getByRole("button", { name: "搜索项目记录", exact: true }).click();
    await page.getByLabel("搜索 ID 或关键词").fill(hintId);
    await page.locator(".search-results button").first().click();
    const hintPriority = page.getByLabel(`提示 ${hintId} 优先级`);
    await hintPriority.waitFor();
    assert.equal(await hintPriority.inputValue(), "3");
    await hintPriority.fill("4");
    await hintPriority.blur();
    await page.waitForFunction(async ({ url, id }) => (await (await fetch(url)).json()).hints.find(h => h.id === id).priority === 4, { url: base + "/api" + p, id: hintId });
    await page.getByRole("button", { name: "编辑 / 关联", exact: true }).click();
    await page.getByLabel("提示内容", { exact: true }).fill("浏览器提示已修订");
    await page.getByRole("button", { name: "保存提示", exact: true }).click();
    await page.getByRole("dialog", { name: "编辑人工提示" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "撤回", exact: true }).click();
    await page.getByRole("dialog", { name: "撤回人工提示" }).getByRole("button", { name: "撤回提示", exact: true }).click();
    await page.getByText("提示已撤回；原始记录与已有产出仍保留在历史。", { exact: true }).waitFor();
    assert.ok((await api(p)).hints.find(h => h.id === hintId).withdrawn_at);
    await page.screenshot({ path: "test-results/hint-lifecycle.png", fullPage: false });

    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => {
      const el = document.querySelector(".graph-canvas"), c = el?._cyreg?.cy;
      return c?.nodes().every(n => { const p = n.renderedPosition(); return p.x >= 0 && p.y >= 0 && p.x <= el.clientWidth && p.y <= el.clientHeight; });
    });
    // 窄屏：项目导航进入侧栏，主内容没有额外顶部页签。
    await page.waitForFunction(
      () => document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
      null,
      { timeout: 5000 },
    );
    await page.screenshot({
      path: "test-results/blackboard-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await page.locator(".workspace > .page-tabs").count(), 0);
    assert.equal(await page.locator(".sidebar .page-tabs button").count(), 10);
    assert.equal(await page.locator(".page-tabs .count").count(), 0);
    await noOverlap(".graph-toolbar", ".graph-layout", "窄屏缩放工具条与布局下拉");
    await noOverlap(".graph-toolbar", ".graph-legend", "窄屏缩放工具条与图例");
    await page.getByRole("button", { name: "打开项目列表" }).click();
    await page.waitForFunction(
      () => document.querySelector(".sidebar").getBoundingClientRect().left >= -1,
    );
    await page.screenshot({
      path: "test-results/mobile-nav.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "关闭项目列表" }).click();
    await page.waitForFunction(
      () => document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });

    // 项目列表：状态数量、运行任务提示、暂停全部、重命名、删除确认
    await page.locator(".brand").click();
    await page.locator(".project-grid").waitFor();
    const list = await api("/projects");
    const filters = page.locator(".project-filter button");
    assert.equal(await filters.count(), 4);
    const counts = await filters.allTextContents();
    assert.ok(counts[0].includes(String(list.length)));
    assert.ok(
      counts[1].includes(
        String(list.filter((x) => x.status === "active").length),
      ),
    );
    const card = page
      .locator(".project-card")
      .filter({ hasText: project.title });
    await card.waitFor();
    assert.match(
      await card.locator(".card-footer span").first().innerText(),
      /Decide|正在探索|等待新信息|已暂停|已完成/,
    );
    // 原版卡片状态数量：Facts / Steps / 未领取 / Hints，另加待批准提示
    const summary = list.find((x) => x.id === project.id);
    const statOf = async (label) =>
      Number(
        (
          await card
            .locator(".card-stats span")
            .filter({ hasText: label })
            .first()
            .innerText()
        )
          .trim()
          .split(/\s+/)[0],
      );
    assert.equal(await statOf("事实"), summary.fact_count);
    assert.equal(await statOf("任务"), summary.intent_count);
    assert.equal(await statOf("待领取"), summary.unclaimed_intent_count);
    assert.equal(await statOf("提示"), summary.hint_count);
    if (summary.pending_asset_count)
      assert.ok(
        (await card.locator(".card-flags").innerText()).includes(
          `${summary.pending_asset_count} 个子域名待批准`,
        ),
      );
    await page.screenshot({
      path: "test-results/projects-desktop.png",
      fullPage: true,
    });

    const activeBefore = list
      .filter((x) => x.status === "active")
      .map((x) => x.id);
    assert.ok(activeBefore.length >= 1);
    await page.getByRole("button", { name: "暂停全部" }).click();
    await page.waitForFunction(
      async (url) => {
        const all = await (await fetch(url)).json();
        return all.every((x) => x.status !== "active");
      },
      base + "/api/projects",
    );
    await card.getByText("已暂停").first().waitFor();
    for (const pid of activeBefore)
      await api("/projects/" + pid + "/status", { status: "active" }, "PUT");

    const newTitle = project.title + " 改名";
    await card.getByRole("button", { name: `重命名 ${project.title}` }).click();
    const opDialog = page.getByRole("dialog", { name: "项目操作" });
    await opDialog.getByLabel("名称").fill(newTitle);
    await opDialog.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForFunction(
      async (arg) =>
        (await (await fetch(arg.url)).json()).title === arg.title,
      { url: base + "/api" + p, title: newTitle },
    );
    await page.getByRole("button", { name: `删除 ${newTitle}` }).click();
    await opDialog.getByRole("checkbox").check();
    await opDialog.getByRole("button", { name: "永久删除全部资源", exact: true }).click();
    await page.waitForFunction(
      (url) => fetch(url).then((r) => r.status === 404),
      base + "/api" + p,
    );
    await page
      .locator(".project-card")
      .filter({ hasText: newTitle })
      .waitFor({ state: "detached" });
    assert.equal(await status(p), 404);
    project = null;
    assert.deepEqual(errors, []);
    console.log(
      "Browser QA passed: 新建项目（多个初始 Hint）、本地 Actor/布局/详情宽度与心跳超时、Origin/Goal/Fact/未知方向圆节点、线状态样式、连线定位 Step、链路视图、六种层级布局、缩放/平移/适应/导出图片、子域名批准、声明与 Claim/Heartbeat/Release/Conclude、多事实选择与移除、优先级与废弃、YAML/时间线预览与复制/下载、时间线定位与回放控制、Finding 人工 Reject/Confirm、证据、审核、暂停全部、重命名、删除确认、完成后 Reopen、深链与移动端布局。",
    );
  } finally {
    try {
      if (project && context) {
        const response = await context.request.delete(base + "/api/projects/" + project.id, { data: { confirmed: true } });
        assert.ok(response.ok(), await response.text());
      }
    } finally {
      await browser.close();
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
