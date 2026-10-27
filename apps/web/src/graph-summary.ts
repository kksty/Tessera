import type { ElementDefinition } from "cytoscape";
import type { Graph } from "../../../packages/protocol/src/index.js";
import { TEST_DOMAIN_LABELS } from "../../../packages/protocol/src/domains.js";
import { resolveGraphRelations } from "../../../packages/protocol/src/graph-relations.js";
import { DEFAULT_DOMAIN, DOMAIN_ORDER } from "../../../packages/core/src/domain-stats.js";

/** 时间线与诊断日志共用的统计实现；这里转出，避免网页侧再从别处 import。 */
export { CORE_DOMAINS, DEFAULT_DOMAIN, DOMAIN_ORDER, domainStats } from "../../../packages/core/src/domain-stats.js";
export type { DomainStat, DomainStats } from "../../../packages/core/src/domain-stats.js";

/** 节点类型 → 中文说法；黑板图例、范围提示和汇总视图共用同一份口径。 */
export const TYPE_LABEL: Record<string, string> = {
  origin: "起点",
  scope: "范围",
  goal: "目标",
  subgoal: "子目标",
  fact: "事实",
  finding: "发现",
  step: "任务",
  hint: "提示",
  navigation: "交接",
  summary: "汇总",
};

/** 汇总节点的阅读顺序：先看锚点，再看过程与结论。 */
const TYPE_ORDER = ["origin", "goal", "subgoal", "scope", "fact", "step", "finding", "hint", "navigation"];

const NODE_PREFIX = "summary-node:";
const EDGE_PREFIX = "summary-edge:";

export const summaryNodeId = (type: string) => `${NODE_PREFIX}${type}`;

/**
 * 按节点类型把整张图压成「一类一个框」，只保留类型之间的连线；线不丢，但会合并。
 *
 * - 未展开的类型合成一个汇总节点，标签写明数量与组内连线数；
 * - 展开的类型保留原节点（`expanded`），组内因果边随之恢复；
 * - 两端都在展开类型里的边保持原样（id / step_id 不变），其余边按
 *   source + target + status 合并并标 `×N`。同类型的内部边不画自环，只计数。
 *
 * 这是「总览」层，不是证据阅读层：合并后的边只说明两类节点有多少联系，
 * 无法指回具体某条事实。需要追溯时展开对应类型，或退出汇总看原图。
 */
export function summaryElements(elements: ElementDefinition[], expanded: Iterable<string> = []): ElementDefinition[] {
  const open = new Set(expanded);
  const isEdge = (el: ElementDefinition) => typeof (el.data as any).source === "string";
  const nodes = elements.filter((el) => !isEdge(el));
  const edges = elements.filter(isEdge);

  const typeOf = new Map<string, string>();
  const byType = new Map<string, ElementDefinition[]>();
  for (const node of nodes) {
    const id = String(node.data.id);
    const type = String(node.data.type || "fact");
    typeOf.set(id, type);
    const list = byType.get(type);
    if (list) list.push(node);
    else byType.set(type, [node]);
  }

  const groups = new Map<string, { count: number; internal: number }>();
  for (const [type, list] of byType) {
    if (!open.has(type)) groups.set(type, { count: list.length, internal: 0 });
  }
  // 先数组内连线：同一类型的边合并后只能写进标签，不能画成自环。
  for (const edge of edges) {
    const data = edge.data as any;
    const sourceType = typeOf.get(String(data.source));
    const targetType = typeOf.get(String(data.target));
    if (!sourceType || sourceType !== targetType || open.has(sourceType)) continue;
    groups.get(sourceType)!.internal += 1;
  }

  const out: ElementDefinition[] = [];
  const types = [...byType.keys()].sort(
    (a, b) => (TYPE_ORDER.indexOf(a) + 1 || 99) - (TYPE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  for (const type of types) {
    const list = byType.get(type)!;
    if (open.has(type)) {
      out.push(...list);
      continue;
    }
    const group = groups.get(type)!;
    const label = TYPE_LABEL[type] || "节点";
    const lines = [`${label} ×${group.count}`];
    if (group.internal) lines.push(`含 ${group.internal} 条组内连线`);
    out.push({
      data: {
        id: summaryNodeId(type),
        label: lines.join("\n"),
        type: "summary",
        groupType: type,
        count: group.count,
        internal: group.internal,
        height: group.internal ? 60 : 48,
      },
    });
  }

  const aggregated = new Map<
    string,
    { source: string; target: string; status: string; count: number; type?: string }
  >();
  const kept: ElementDefinition[] = [];
  for (const edge of edges) {
    const data = edge.data as any;
    const sourceType = typeOf.get(String(data.source));
    const targetType = typeOf.get(String(data.target));
    if (!sourceType || !targetType) continue;
    const sourceOpen = open.has(sourceType);
    const targetOpen = open.has(targetType);
    const source = sourceOpen ? String(data.source) : summaryNodeId(sourceType);
    const target = targetOpen ? String(data.target) : summaryNodeId(targetType);
    if (source === target) continue;
    // 两端都已展开：保留原边，选中/定位仍能按 step_id 工作。
    if (sourceOpen && targetOpen) {
      kept.push(edge);
      continue;
    }
    const status = String(data.status || "");
    const key = `${source}\u0000${target}\u0000${status}`;
    const current = aggregated.get(key);
    if (current) current.count += 1;
    else aggregated.set(key, { source, target, status, count: 1, type: data.type });
  }

  for (const edge of aggregated.values()) {
    out.push({
      data: {
        id: `${EDGE_PREFIX}${edge.source}->${edge.target}:${edge.status}`,
        source: edge.source,
        target: edge.target,
        status: edge.status,
        // 合并后的边标数量；单条边不借用原来的 step 编号，避免看起来像能定位。
        label: edge.count > 1 ? `×${edge.count}` : "",
        count: edge.count,
        type: "summary",
      },
    });
  }
  out.push(...kept);
  return out;
}

/** 测试域 → 中文说法；统一从协议取，黑板、详情和日志导出口径一致。 */
export const DOMAIN_LABEL: Record<string, string> = TEST_DOMAIN_LABELS;

/** 后渗透的第二级：固定前缀，冒号后写站点细节。 */
export const POST_FOCUS_ORDER = ["提权", "凭据", "横向", "持久化", "影响", "反溯源"];

const DOMAIN_NODE_PREFIX = "domain-node:";
const FOCUS_NODE_PREFIX = "domain-focus:";

export const domainNodeId = (domain: string) => `${DOMAIN_NODE_PREFIX}${domain}`;
export const focusNodeId = (domain: string, prefix: string) => `${FOCUS_NODE_PREFIX}${domain}:${prefix}`;

/** 「提权：SUID」→「提权」；不认识的写法归入「其他」，不因为拼写差异多出空组。 */
export function focusPrefix(focus?: string): string {
  const prefix = (focus ?? "").split(/[:：]/)[0]?.trim() ?? "";
  return POST_FOCUS_ORDER.includes(prefix) ? prefix : "其他";
}

/** 事实/发现从生产它的 Step 继承域与 focus；起点、范围、目标、提示保持独立节点。 */
function domainIndex(graph: Graph) {
  const relations = resolveGraphRelations(graph);
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const factById = new Map(graph.facts.map((fact) => [fact.id, fact]));
  const findingById = new Map(graph.findings.map((finding) => [finding.id, finding]));
  const producerOfFact = (id: string): string | undefined =>
    factById.get(id)?.step_id ?? relations.facts.get(id)?.producers[0]?.step_id;
  const producerOfFinding = (id: string): string | undefined => {
    const finding = findingById.get(id);
    if (!finding) return undefined;
    const recorded =
      finding.step_id ??
      finding.revision_step_id ??
      (relations.upstream.get(id) ?? []).find((edge) => edge.kind === "finding_production")?.source;
    return recorded ?? finding.from.map(producerOfFact).find((value) => !!value);
  };
  /** 节点 → 域；没有域归属的锚点返回 undefined，单独显示。 */
  const domainOf = (id: string, type: string): { domain: string; focus?: string } | undefined => {
    if (type === "step") {
      const step = stepById.get(id);
      return { domain: step?.test_domain ?? DEFAULT_DOMAIN, focus: step?.focus };
    }
    if (type === "fact") {
      const producer = stepById.get(producerOfFact(id) ?? "");
      return { domain: producer?.test_domain ?? DEFAULT_DOMAIN, focus: producer?.focus };
    }
    if (type === "finding") {
      const producer = stepById.get(producerOfFinding(id) ?? "");
      return { domain: producer?.test_domain ?? DEFAULT_DOMAIN, focus: producer?.focus };
    }
    return undefined;
  };
  return { domainOf };
}

interface DomainGroup {
  key: string;
  domain: string;
  focus?: string;
  members: string[];
}

/**
 * 按「测试域」汇总：Step 按自己的 test_domain 归组，Fact / Finding 跟随生产它们的 Step。
 * 起点、范围、目标与提示仍是独立节点，因为它们是锚点而不是测试产出。
 *
 * 展开一个域就显示该域的真实节点；`post` 先展开成 focus 前缀的二级框，
 * 再展开到 Step / Fact。空域不渲染，未分类的节点落在 other。
 * 与按类型汇总共用一套边合并规则：组内边只计数，跨组边合并并标 `×N`。
 */
export function domainSummaryElements(
  elements: ElementDefinition[],
  graph: Graph,
  expanded: Iterable<string> = [],
): ElementDefinition[] {
  const open = new Set(expanded);
  const isEdge = (el: ElementDefinition) => typeof (el.data as any).source === "string";
  const nodes = elements.filter((el) => !isEdge(el));
  const edges = elements.filter(isEdge);
  const { domainOf } = domainIndex(graph);

  const nodeIds = new Set(nodes.map((node) => String(node.data.id)));
  const nodeType = new Map<string, string>();
  for (const node of nodes) nodeType.set(String(node.data.id), String(node.data.type || "fact"));

  const assignment = new Map<string, { domain: string; focus?: string }>();
  for (const node of nodes) {
    const id = String(node.data.id);
    const value = domainOf(id, nodeType.get(id)!);
    if (value) assignment.set(id, value);
  }

  // post 只有一个「其他」前缀时，二级框没有信息量，直接展开到节点。
  const postPrefixes = new Set(
    [...assignment].filter(([, value]) => value.domain === "post").map(([, value]) => focusPrefix(value.focus)),
  );
  const postSplits = postPrefixes.size > 1 || !postPrefixes.has("其他");

  const groups = new Map<string, DomainGroup>();
  const grouped = new Map<string, string>();
  const member = (key: string, domain: string, id: string, focus?: string) => {
    const group = groups.get(key);
    if (group) group.members.push(id);
    else groups.set(key, { key, domain, focus, members: [id] });
    grouped.set(id, key);
  };
  for (const node of nodes) {
    const id = String(node.data.id);
    const value = assignment.get(id);
    if (!value) continue;
    if (!open.has(domainNodeId(value.domain))) {
      member(domainNodeId(value.domain), value.domain, id);
      continue;
    }
    // 域已展开：非 post 直接显示真实节点；post 先看 focus 前缀。
    if (value.domain !== "post" || !postSplits) continue;
    const prefix = focusPrefix(value.focus);
    if (open.has(focusNodeId("post", prefix))) continue;
    member(focusNodeId("post", prefix), "post", id, prefix);
  }

  // 组内连线只计数：同一域的因果边在总览里画成自环没有意义。
  const internal = new Map<string, number>();
  for (const edge of edges) {
    const source = grouped.get(String((edge.data as any).source));
    const target = grouped.get(String((edge.data as any).target));
    if (!source || source !== target) continue;
    internal.set(source, (internal.get(source) ?? 0) + 1);
  }

  const order = (domain: string) => {
    const index = DOMAIN_ORDER.indexOf(domain);
    return index < 0 ? DOMAIN_ORDER.length : index;
  };
  const sorted = [...groups.values()].sort(
    (a, b) =>
      order(a.domain) - order(b.domain) || (a.focus ?? "").localeCompare(b.focus ?? "") || a.key.localeCompare(b.key),
  );

  const out: ElementDefinition[] = [];
  const kindCount = (group: DomainGroup, type: string) =>
    group.members.filter((id) => (nodeType.get(id) ?? "fact") === type).length;
  for (const group of sorted) {
    const count = group.members.length;
    const steps = kindCount(group, "step");
    const facts = kindCount(group, "fact");
    const findings = kindCount(group, "finding");
    const lines = [
      group.domain === "post" && group.focus
        ? `${group.focus} ×${count}`
        : `${DOMAIN_LABEL[group.domain] || group.domain} ×${count}`,
    ];
    const parts = [
      steps ? `任务 ${steps}` : "",
      facts ? `事实 ${facts}` : "",
      findings ? `发现 ${findings}` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(parts.join(" · "));
    // 收起状态的 post 框直接写出前缀分布，不用先点开才知道做了什么。
    if (group.domain === "post" && !group.focus && postSplits) {
      const prefixes = new Map<string, number>();
      for (const id of group.members) {
        const prefix = focusPrefix(assignment.get(id)?.focus);
        prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
      lines.push(
        [...prefixes]
          .sort((a, b) => (POST_FOCUS_ORDER.indexOf(a[0]) + 1 || 99) - (POST_FOCUS_ORDER.indexOf(b[0]) + 1 || 99))
          .map(([prefix, value]) => `${prefix} ${value}`)
          .join(" · "),
      );
    }
    out.push({
      data: {
        id: group.key,
        label: lines.join("\n"),
        type: "summary",
        summaryKind: group.focus ? "focus" : "domain",
        groupType: group.key,
        domain: group.domain,
        count,
        internal: internal.get(group.key) ?? 0,
        height: 46 + (lines.length - 1) * 16,
      },
    });
  }

  const aggregated = new Map<string, { source: string; target: string; status: string; count: number }>();
  const kept: ElementDefinition[] = [];
  for (const edge of edges) {
    const data = edge.data as any;
    const source = String(data.source);
    const target = String(data.target);
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const sourceGroup = grouped.get(source) ?? source;
    const targetGroup = grouped.get(target) ?? target;
    if (sourceGroup === targetGroup) continue;
    // 两端都是真实节点：保留原边和 step_id，选中与定位仍然可用。
    if (!grouped.has(source) && !grouped.has(target)) {
      kept.push(edge);
      continue;
    }
    const status = String(data.status || "");
    const key = `${sourceGroup}\u0000${targetGroup}\u0000${status}`;
    const current = aggregated.get(key);
    if (current) current.count += 1;
    else aggregated.set(key, { source: sourceGroup, target: targetGroup, status, count: 1 });
  }

  for (const edge of aggregated.values()) {
    out.push({
      data: {
        id: `${EDGE_PREFIX}${edge.source}->${edge.target}:${edge.status}`,
        source: edge.source,
        target: edge.target,
        status: edge.status,
        label: edge.count > 1 ? `×${edge.count}` : "",
        count: edge.count,
        type: "summary",
      },
    });
  }
  for (const node of nodes) if (!grouped.has(String(node.data.id))) out.push(node);
  out.push(...kept);
  return out;
}
