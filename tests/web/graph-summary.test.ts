import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { graphElements } from "../../apps/web/src/Blackboard.js";
import {
  DOMAIN_LABEL,
  domainNodeId,
  domainSummaryElements,
  focusPrefix,
  summaryElements,
  summaryNodeId,
  TYPE_LABEL,
} from "../../apps/web/src/graph-summary.js";

type Data = Record<string, string | number | undefined>;
type Element = { data: Data; position?: { x: number; y: number } };
const node = (id: string, type: string, extra: Data = {}): Element => ({ data: { id, type, ...extra } });
const edge = (id: string, source: string, target: string, status: string, extra: Data = {}): Element => ({
  data: { id, source, target, status, type: "flow", ...extra },
});

const byId = (elements: Element[], id: string) => elements.find((el) => el.data.id === id);
const edges = (elements: Element[]) => elements.filter((el) => typeof el.data.source === "string");
const nodes = (elements: Element[]) => elements.filter((el) => typeof el.data.source !== "string");
const present = (elements: Element[]) => new Set(nodes(elements).map((el) => String(el.data.id)));

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

test("类型汇总：一类一个框，数量写成「N 个节点」，组内边只计数不画自环", () => {
  const out = summaryElements(fixture() as any);
  const fact = byId(out, summaryNodeId("fact"))!;
  assert.equal(fact.data.type, "summary");
  assert.equal(fact.data.groupType, "fact");
  assert.equal(fact.data.count, 2);
  assert.equal(fact.data.internal, 1, "事实 → 事实的因果边应计入组内连线，而不是画成自环");
  assert.equal(fact.data.label, `${TYPE_LABEL.fact} · 2 个节点\n组内 1 条关联`);
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
  assert.equal(
    out.some((el) => String(el.data.label || "").includes("×")),
    false,
    "数量不再用不解释的乘号",
  );
});

test("类型汇总：展开一个类型只恢复该类节点，两端都恢复的边沿用原始元素", () => {
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

test("类型汇总：全部展开时就是原图，元素集合不变且节点排在边前", () => {
  const input = fixture();
  const out = summaryElements(input as any, ["origin", "fact", "step", "finding"]);
  assert.deepEqual(new Set(out.map((el) => el.data.id)), new Set(input.map((el) => el.data.id)));
  assert.equal(edges(out).length, input.filter((el) => typeof el.data.source === "string").length);
  assert.equal(nodes(out).length, input.filter((el) => typeof el.data.source !== "string").length);
  const firstEdge = out.findIndex((el) => typeof el.data.source === "string");
  const lastNode = out.findLastIndex((el) => typeof el.data.source !== "string");
  assert.ok(lastNode < firstEdge, "节点必须先于边，cytoscape 才能逐条 add");
});

test("类型汇总：没有节点的空图不会被汇总出空框，悬空边会被丢弃", () => {
  assert.deepEqual(summaryElements([]), []);
  const orphan = [{ data: { id: "only", type: "fact" } }];
  const out = summaryElements(orphan as any);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.count, 1);
  assert.equal(out[0].data.internal, 0);
  const dangling = summaryElements([node("origin", "origin"), edge("bad", "origin", "missing", "concluded")] as any);
  for (const el of edges(dangling)) {
    const ids = present(dangling);
    assert.ok(ids.has(String(el.data.source)) && ids.has(String(el.data.target)));
  }
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
  const reconFact = fact(recon.id, "admin.example.test resolves");
  const injectFact = fact(inject.id, "Reflected payload returns verbatim");
  const escalationFact = fact(escalation.id, "root shell obtained");
  const lateralFact = fact(lateral.id, "SMB share readable");
  fact(legacy.id, "Legacy check recorded");
  store.submitFinding(
    id,
    findingSchema.parse({ title: "Reflected XSS", description: "Search box reflects input", from: [injectFact.id] }),
  );
  return {
    store,
    graph: store.get(id),
    steps: { recon, inject, escalation, lateral, legacy },
    facts: { recon: reconFact, inject: injectFact, escalation: escalationFact, lateral: lateralFact },
  };
}

test("按测试域分框：每个域一个框，Step / Fact / Finding 作为真实节点放在框里", () => {
  const { store, graph, steps, facts } = domainGraph();
  try {
    const elements = graphElements(graph, "main");
    const out = domainSummaryElements(elements, graph);

    const recon = byId(out, domainNodeId("recon"))!;
    assert.equal(recon.data.type, "summary");
    assert.equal(recon.data.summaryKind, "domain");
    assert.equal(recon.data.frame, 1);
    assert.equal(recon.data.groupType, domainNodeId("recon"));
    assert.equal(recon.data.count, 2);
    assert.equal(recon.data.label, `${DOMAIN_LABEL.recon} · 2 个节点\n任务 1 · 事实 1\n组内 1 条关联`);
    assert.equal(recon.data.internal, 1, "Step → 自己产出的事实是组内连线，只计数不画线");
    assert.ok(byId(out, steps.recon.id), "展开动作不再需要：真实任务就在框里");
    assert.ok(byId(out, facts.recon.id), "真实事实也在框里");
    const member = byId(out, steps.recon.id)!;
    assert.equal(member.data.type, "step", "任务保留 step 类型");
    assert.equal(member.data.label, "?", "任务仍显示原来的圆圈问号");
    assert.equal(member.data.grouped, undefined, "任务不要转成方框卡片");
    assert.equal(member.data.group, "recon");
    assert.ok(member.position, "成员有确定的卡片内坐标");
    const factMember = byId(out, facts.recon.id)!;
    assert.equal(factMember.data.grouped, 1, "事实仍用紧凑卡片");
    assert.ok(factMember.position);
    assert.equal(
      (byId(elements, steps.recon.id)!.data as any).group,
      undefined,
      "分框不能把 group 写回原始图元素，否则退出汇总后仍残留汇总标记",
    );

    // 事实与发现不单独打标：它们跟随生产 Step 落在同一个域里。
    const inject = byId(out, domainNodeId("inject"))!;
    assert.equal(inject.data.count, 3);
    assert.equal(inject.data.internal, 2, "Step → 事实 → 发现两条组内边");
    assert.equal(inject.data.label, `${DOMAIN_LABEL.inject} · 3 个节点\n任务 1 · 事实 1 · 发现 1\n组内 2 条关联`);

    // 旧项目没有 test_domain：显示「未分类」，不隐藏也不需要迁移。
    const other = byId(out, domainNodeId("other"))!;
    assert.equal(other.data.count, 2);
    assert.ok(String(other.data.label).startsWith(`${DOMAIN_LABEL.other} · 2 个节点`));

    // 空域不渲染。
    assert.equal(byId(out, domainNodeId("logic")), undefined);

    // 起点是锚点，不是测试产出，保持独立节点，且不放进任何卡片。
    assert.ok(byId(out, "origin"));
    assert.equal(byId(out, "origin")!.data.grouped, undefined);

    // post 在框头写出 focus 分布，四名成员仍放在同一个后渗透大框里。
    const post = byId(out, domainNodeId("post"))!;
    assert.equal(post.data.count, 4);
    assert.match(String(post.data.label), /提权 2/);
    assert.match(String(post.data.label), /横向 2/);
    assert.ok(byId(out, steps.escalation.id));
    assert.ok(byId(out, steps.lateral.id));
    assert.ok(byId(out, facts.escalation.id));
    assert.ok(byId(out, facts.lateral.id));

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
    assert.equal(
      out.some((el) => String(el.data.label || "").includes("×")),
      false,
      "框头和连线上不再出现不解释的乘号",
    );
  } finally {
    store.close();
  }
});

test("按测试域分框：每条边两端都存在，节点先于边，成员落在自己的框内", () => {
  const { store, graph } = domainGraph();
  try {
    const out = domainSummaryElements(graphElements(graph, "main"), graph);
    const ids = present(out);
    const firstEdge = out.findIndex((el) => typeof el.data.source === "string");
    const lastNode = out.findLastIndex((el) => typeof el.data.source !== "string");
    assert.ok(lastNode < firstEdge, "节点必须先于边，避免 cytoscape add 边时报源不存在");
    for (const el of edges(out)) {
      assert.ok(ids.has(String(el.data.source)), `edge source exists: ${el.data.source}`);
      assert.ok(ids.has(String(el.data.target)), `edge target exists: ${el.data.target}`);
    }
    for (const member of nodes(out).filter((el) => el.data.group)) {
      const frame = byId(out, domainNodeId(String(member.data.group)))!;
      assert.ok(frame, `member ${member.data.id} has a frame`);
      if (member.data.type === "step") {
        assert.equal(member.data.grouped, undefined, "任务在框内仍是圆圈，不是方框卡片");
      }
      const position = member.position!;
      const framePosition = frame.position!;
      const left = framePosition.x - Number(frame.data.width) / 2;
      const right = framePosition.x + Number(frame.data.width) / 2;
      const top = framePosition.y - Number(frame.data.height) / 2;
      const bottom = framePosition.y + Number(frame.data.height) / 2;
      assert.ok(position.x > left && position.x < right, `${member.data.id} 横向在框内`);
      assert.ok(position.y > top && position.y < bottom, `${member.data.id} 纵向在框内`);
    }
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
