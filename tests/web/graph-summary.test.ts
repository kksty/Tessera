import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { graphElements } from "../../apps/web/src/Blackboard.js";
import {
  DOMAIN_LABEL,
  domainNodeId,
  domainSummaryElements,
  focusNodeId,
  focusPrefix,
  summaryElements,
  summaryNodeId,
  TYPE_LABEL,
} from "../../apps/web/src/graph-summary.js";

type Data = Record<string, string | number | undefined>;
const node = (id: string, type: string, extra: Data = {}) => ({ data: { id, type, ...extra } });
const edge = (id: string, source: string, target: string, status: string, extra: Data = {}) => ({
  data: { id, source, target, status, type: "flow", ...extra },
});

const byId = (elements: { data: Data }[], id: string) => elements.find((el) => el.data.id === id);
const edges = (elements: { data: Data }[]) => elements.filter((el) => typeof el.data.source === "string");
const nodes = (elements: { data: Data }[]) => elements.filter((el) => typeof el.data.source !== "string");

/** 起点 → 事实1 → 事实2 → 发现；另有一条任务 → 事实1 的生产边。 */
function fixture(): any[] {
  return [
    node("origin", "origin"),
    node("f1", "fact"),
    node("f2", "fact"),
    node("s1", "step"),
    node("g1", "finding"),
    edge("e1", "origin", "f1", "concluded"),
    edge("e2", "f1", "f2", "concluded", { step_id: "s2" }),
    edge("e3", "s1", "f1", "concluded", { step_id: "s1" }),
    edge("e4", "f2", "g1", "finding"),
  ];
}

test("汇总视图一类一个框，类型之间的线保留并标数量，同类内部边只计数不画自环", () => {
  const out = summaryElements(fixture() as any);
  const fact = byId(out, summaryNodeId("fact"))!;
  assert.equal(fact.data.type, "summary");
  assert.equal(fact.data.groupType, "fact");
  assert.equal(fact.data.count, 2);
  assert.equal(fact.data.internal, 1, "事实 → 事实的因果边应计入组内连线，而不是画成自环");
  assert.equal(fact.data.label, `${TYPE_LABEL.fact} ×2\n含 1 条组内连线`);
  assert.ok(byId(out, summaryNodeId("origin")));
  assert.ok(byId(out, summaryNodeId("step")));
  assert.ok(byId(out, summaryNodeId("finding")));
  // 原始节点全部收起。
  for (const id of ["origin", "f1", "f2", "s1", "g1"]) assert.equal(byId(out, id), undefined);

  assert.equal(edges(out).length, 3, "起点→事实、任务→事实、事实→发现");
  const originFact = edges(out).find(
    (el) => el.data.source === summaryNodeId("origin") && el.data.target === summaryNodeId("fact"),
  );
  assert.ok(originFact);
  const factFinding = edges(out).find(
    (el) => el.data.source === summaryNodeId("fact") && el.data.target === summaryNodeId("finding"),
  );
  assert.ok(factFinding);
  assert.equal(factFinding!.data.status, "finding", "状态保留，发现链路的颜色不变");
  assert.equal(
    edges(out).some((el) => el.data.source === summaryNodeId("fact") && el.data.target === summaryNodeId("fact")),
    false,
  );
  assert.equal(new Set(out.map((el) => el.data.id)).size, out.length, "汇总元素 ID 不重复");
});

test("展开一个类型只恢复该类节点，两端都恢复的边沿用原始元素", () => {
  const out = summaryElements(fixture() as any, ["fact"]);
  assert.ok(byId(out, "f1") && byId(out, "f2"));
  assert.equal(byId(out, summaryNodeId("fact")), undefined);
  assert.ok(byId(out, summaryNodeId("origin")), "其他类型仍然汇总");
  // 事实→事实两端都展开：保留原边和 step_id，点选/定位仍可用。
  const kept = byId(out, "e2")!;
  assert.equal(kept.data.source, "f1");
  assert.equal(kept.data.target, "f2");
  assert.equal(kept.data.step_id, "s2");
  assert.equal(kept.data.type, "flow");
  // 一端仍汇总的边转成组边。
  const fromOrigin = edges(out).find((el) => el.data.target === "f1" && el.data.source === summaryNodeId("origin"));
  assert.ok(fromOrigin);
  assert.equal(fromOrigin!.data.step_id, undefined, "合并边不借用 step_id，避免看起来可定位");
  assert.equal(
    edges(out).some((el) => el.data.source === "f1" && el.data.target === "f2" && el.data.id !== "e2"),
    false,
  );
});

test("全部展开时就是原图（元素集合不变，仅顺序按节点在前）", () => {
  const input = fixture();
  const out = summaryElements(input as any, ["origin", "fact", "step", "finding"]);
  assert.deepEqual(new Set(out.map((el) => el.data.id)), new Set(input.map((el) => el.data.id)));
  assert.equal(edges(out).length, input.filter((el) => typeof el.data.source === "string").length);
  assert.equal(nodes(out).length, input.filter((el) => typeof el.data.source !== "string").length);
});

test("没有节点的空图不会被汇总出空框", () => {
  assert.deepEqual(summaryElements([]), []);
  const orphan = [{ data: { id: "only", type: "fact" } }];
  const out = summaryElements(orphan as any);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.count, 1);
  assert.equal(out[0].data.internal, 0);
});

/** 真实 Store 建图：分类走人工 Step，事实与发现按生产关系继承。 */
function domainGraph() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Domains", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const step = (input: { description: string; test_domain?: any; focus?: string }) =>
    store.manualStep(id, { from: ["origin"], creator: "human", claim: true, ...input });
  const recon = step({ description: "Enumerate subdomains", test_domain: "recon" });
  const inject = step({ description: "Probe the search box", test_domain: "inject", focus: "注入：反射型" });
  const escalation = step({ description: "Escalate with SUID", test_domain: "post", focus: "提权：SUID" });
  const lateral = step({ description: "Reach the file server", test_domain: "post", focus: "横向：SMB" });
  const legacy = step({ description: "Old manual check" });
  const fact = (stepId: string, description: string) =>
    store.fact(id, stepId, { worker: "human", description, evidence_ids: [] });
  fact(recon.id, "admin.example.test resolves");
  const injectFact = fact(inject.id, "Reflected payload returns verbatim");
  fact(escalation.id, "root shell obtained");
  fact(lateral.id, "SMB share readable");
  fact(legacy.id, "Legacy check recorded");
  store.submitFinding(
    id,
    findingSchema.parse({ title: "Reflected XSS", description: "Search box reflects input", from: [injectFact.id] }),
  );
  return { store, graph: store.get(id), steps: { recon, inject, escalation, lateral, legacy } };
}

test("按测试域汇总：Step 按域归组，Fact / 发现跟随生产 Step，未分类落在 other", () => {
  const { store, graph, steps } = domainGraph();
  try {
    const elements = graphElements(graph, "main");
    const out = domainSummaryElements(elements, graph);

    const recon = byId(out, domainNodeId("recon"))!;
    assert.equal(recon.data.type, "summary");
    assert.equal(recon.data.summaryKind, "domain");
    assert.equal(recon.data.groupType, domainNodeId("recon"));
    assert.equal(recon.data.count, 2);
    assert.equal(recon.data.label, `${DOMAIN_LABEL.recon} ×2\n任务 1 · 事实 1`);
    assert.equal(recon.data.internal, 1, "Step → 自己产出的事实是组内连线，只计数不画自环");

    // 事实与发现不单独打标：它们跟随生产 Step 落在同一个域里。
    const inject = byId(out, domainNodeId("inject"))!;
    assert.equal(inject.data.count, 3);
    assert.equal(inject.data.internal, 2, "Step → 事实 → 发现两条组内边");
    assert.match(String(inject.data.label), /任务 1 · 事实 1 · 发现 1/);

    // 旧项目没有 test_domain：显示「未分类」，不隐藏也不需要迁移。
    const other = byId(out, domainNodeId("other"))!;
    assert.equal(other.data.count, 2);
    assert.ok(String(other.data.label).startsWith(`${DOMAIN_LABEL.other} ×2`));

    // 空域不渲染。
    assert.equal(byId(out, domainNodeId("logic")), undefined);

    // 起点是锚点，不是测试产出，保持独立节点。
    assert.ok(byId(out, "origin"));

    // 收起的 post 框直接写 focus 前缀分布。
    const post = byId(out, domainNodeId("post"))!;
    assert.equal(post.data.count, 4);
    assert.match(String(post.data.label), /提权 2/);
    assert.match(String(post.data.label), /横向 2/);

    // 跨组边合并计数；组内边不画。
    const originRecon = edges(out).find(
      (el) => el.data.source === "origin" && el.data.target === domainNodeId("recon"),
    )!;
    assert.equal(originRecon.data.count, 1, "Step→事实是组内边，只剩 origin→Step 一条");
    assert.equal(originRecon.data.step_id, undefined, "合并边不借用 step_id");
    assert.equal(
      edges(out).some((el) => el.data.source === steps.recon.id),
      false,
    );

    assert.equal(new Set(out.map((el) => el.data.id)).size, out.length, "汇总元素 ID 不重复");
  } finally {
    store.close();
  }
});

test("展开 post 先出 focus 二级框，再展开到真实节点；其他域保持汇总", () => {
  const { store, graph, steps } = domainGraph();
  try {
    const elements = graphElements(graph, "main");
    const postOpen = domainSummaryElements(elements, graph, [domainNodeId("post")]);
    assert.equal(byId(postOpen, domainNodeId("post")), undefined);
    const escalation = byId(postOpen, focusNodeId("post", "提权"))!;
    assert.equal(escalation.data.summaryKind, "focus");
    assert.equal(escalation.data.count, 2);
    assert.equal(escalation.data.label, "提权 ×2\n任务 1 · 事实 1");
    assert.ok(byId(postOpen, domainNodeId("recon")), "其他域仍然汇总");
    assert.equal(byId(postOpen, domainNodeId("inject"))!.data.count, 3);

    const deep = domainSummaryElements(elements, graph, [domainNodeId("post"), focusNodeId("post", "提权")]);
    assert.ok(byId(deep, steps.escalation.id), "展开的前缀恢复真实 Step");
    assert.ok(byId(deep, focusNodeId("post", "横向")), "未展开的前缀仍是框");
  } finally {
    store.close();
  }
});

test("post 没有可用 focus 前缀时直接展开到节点，不套一个空的「其他」框", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Post", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "Escalate privileges",
      creator: "human",
      claim: true,
      test_domain: "post",
    });
    const graph = store.get(id);
    const elements = graphElements(graph, "main");
    const out = domainSummaryElements(elements, graph, [domainNodeId("post")]);
    assert.ok(byId(out, step.id), "唯一的「其他」前缀没有二级框");
    assert.equal(byId(out, focusNodeId("post", "其他")), undefined);
  } finally {
    store.close();
  }
});

test("focus 前缀只认固定写法，其余归入「其他」", () => {
  assert.equal(focusPrefix("提权：SUID"), "提权");
  assert.equal(focusPrefix("横向: SMB"), "横向");
  assert.equal(focusPrefix("凭据：浏览器存储"), "凭据");
  assert.equal(focusPrefix("随便写"), "其他");
  assert.equal(focusPrefix(undefined), "其他");
});
