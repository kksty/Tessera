import type { ElementDefinition } from "cytoscape";
import type { Graph } from "../../../packages/protocol/src/index.js";
import { TEST_DOMAIN_LABELS } from "../../../packages/protocol/src/domains.js";
import { resolveGraphRelations } from "../../../packages/protocol/src/graph-relations.js";
import { DEFAULT_DOMAIN, DOMAIN_ORDER } from "../../../packages/core/src/domain-stats.js";
import { fitNodeLabel } from "./label-fit.js";

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
/** 域框内部的阅读顺序：先看「问过什么」，再看产出与结论。 */
const MEMBER_ORDER = ["step", "fact", "finding", "hint", "goal", "subgoal", "scope", "navigation"];

const NODE_PREFIX = "summary-node:";
const EDGE_PREFIX = "summary-edge:";

export const summaryNodeId = (type: string) => `${NODE_PREFIX}${type}`;

const isEdge = (el: ElementDefinition) => typeof (el.data as any).source === "string";
const nodeIdOf = (el: ElementDefinition) => String(el.data.id);

/** 所有汇总输出都先放节点、再放边，并过滤掉指向不存在节点的边。
 *  过去按测试域展开时，合并边会排在未归组节点之前；cytoscape 逐条 add 时
 *  遇到「边先于节点」直接抛错，React 错误边界随即显示「工作区加载失败」。 */
function finishElements(nodes: ElementDefinition[], edges: ElementDefinition[]) {
  const present = new Set(nodes.map(nodeIdOf));
  const safeEdges = edges.filter(
    (edge) => present.has(String((edge.data as any).source)) && present.has(String((edge.data as any).target)),
  );
  return [...nodes, ...safeEdges];
}

/**
 * 按节点类型把整张图压成「一类一个框」，只保留类型之间的连线；线不丢，但会合并。
 *
 * - 未展开的类型合成一个汇总节点，标签写明数量与组内连线数；
 * - 展开的类型保留原节点（`expanded`），组内因果边随之恢复；
 * - 两端都在展开类型里的边保持原样（id / step_id 不变），其余边按
 *   source + target + status 合并并标「N 条关联」。同类型的内部边不画自环，只计数。
 *
 * 这是「总览」层，不是证据阅读层：合并后的边只说明两类节点有多少联系，
 * 无法指回具体某条事实。需要追溯时展开对应类型，或退出汇总看原图。
 */
export function summaryElements(elements: ElementDefinition[], expanded: Iterable<string> = []): ElementDefinition[] {
  const open = new Set(expanded);
  const nodes = elements.filter((el) => !isEdge(el));
  const edges = elements.filter(isEdge);

  const typeOf = new Map<string, string>();
  const byType = new Map<string, ElementDefinition[]>();
  for (const node of nodes) {
    const id = nodeIdOf(node);
    const type = String((node.data as any).type || "fact");
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
    const lines = [`${label} · ${group.count} 个节点`];
    if (group.internal) lines.push(`组内 ${group.internal} 条关联`);
    out.push({
      data: {
        id: summaryNodeId(type),
        label: lines.join("\n"),
        type: "summary",
        groupType: type,
        count: group.count,
        internal: group.internal,
        height: group.internal ? 62 : 48,
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
    // 同一对类型之间只保留一条线：状态只决定颜色，数量写进标签，避免多条平行边互相压字。
    const key = `${source}\u0000${target}`;
    const current = aggregated.get(key);
    if (current) {
      current.count += 1;
      if ((STATUS_RANK[status] ?? -1) > (STATUS_RANK[current.status] ?? -1)) current.status = status;
    } else aggregated.set(key, { source, target, status, count: 1, type: data.type });
  }

  const aggregateEdges: ElementDefinition[] = [];
  for (const edge of aggregated.values()) {
    aggregateEdges.push({
      data: {
        id: `${EDGE_PREFIX}${edge.source}->${edge.target}:${edge.status}`,
        source: edge.source,
        target: edge.target,
        status: edge.status,
        // 合并后的边标数量；单条边不借用原来的 step 编号，避免看起来像能定位。
        label: edge.count > 1 ? `${edge.count} 条关联` : "",
        count: edge.count,
        type: "summary",
      },
    });
  }
  return finishElements(out, [...aggregateEdges, ...kept]);
}

/** 测试域 → 中文说法；统一从协议取，黑板、详情和日志导出口径一致。 */
export const DOMAIN_LABEL: Record<string, string> = TEST_DOMAIN_LABELS;

/** 后渗透的第二级：固定前缀，冒号后写站点细节。 */
export const POST_FOCUS_ORDER = ["提权", "凭据", "横向", "持久化", "影响", "反溯源"];

const DOMAIN_NODE_PREFIX = "domain-node:";

export const domainNodeId = (domain: string) => `${DOMAIN_NODE_PREFIX}${domain}`;

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

const CARD = {
  nodeWidth: 168,
  nodeHeight: 50,
  textWidth: 148,
  gap: 10,
  pad: 16,
  cardGap: 22,
  rowGap: 18,
  anchorGap: 28,
  anchorRowGap: 24,
  headerLine: 23,
  headerPad: 26,
  domainTop: 74,
  // 任务仍用原来的圆圈「?」，只是排进域框时给一个紧凑格子；不要改成方框卡片。
  stepCell: 36,
  stepGap: 8,
  // 和 Blackboard 里 node[type="summary"][frame=1] 的 font-size 保持一致。
  // fitNodeLabel 的字宽基准是 13px，标题字号更大时必须按比例收窄预算，
  // 否则框头会多折一行，压到第一排节点上。
  titleFont: 16.5,
  titleBaseFont: 13,
};

const ANCHOR_WIDTH: Record<string, number> = {
  origin: 164,
  goal: 180,
  subgoal: 156,
  scope: 166,
  hint: 164,
  navigation: 164,
};

const ANCHOR_ORDER = ["origin", "goal", "scope", "hint", "subgoal", "navigation"];
const ANCHORS_PER_ROW = 3;

/** 一张卡片里放几列节点：1–2 个用单/双列，3–6 个双列，更多三列。 */
function cardColumns(count: number) {
  if (count <= 2) return Math.max(1, count);
  if (count <= 6) return 2;
  return 3;
}

function cardWidth(columns: number) {
  // 单列卡不能只有「一个节点宽」：框头是 16.5px 的字，太窄会把「节点」这类词
  // 从中间折开。最少留 232px，节点仍按 168px 排列，多出来的是标题呼吸空间。
  return Math.max(232, columns * CARD.nodeWidth + (columns - 1) * CARD.gap + CARD.pad * 2);
}

/** 事实 / 发现的标签只保留两行；任务保持原来的圆圈「?」，不经过这里。 */
function compactGroupedNode(node: ElementDefinition, domain: string, focus: string | undefined): ElementDefinition {
  const data = node.data as any;
  const raw = String(data.label || data.description || data.id || "");
  const prefix = domain === "post" && focus && focusPrefix(focus) !== "其他" ? `${focusPrefix(focus)} · ` : "";
  const fitted = fitNodeLabel(`${prefix}${raw}`, CARD.textWidth, 2);
  return {
    ...node,
    data: {
      ...data,
      label: fitted.label,
      height: CARD.nodeHeight,
      grouped: 1,
      group: domain,
    },
  };
}

/** 边合并成域间连线时，选一个最有信息量的状态决定颜色；数量写在标签里。 */
const STATUS_RANK: Record<string, number> = {
  running: 6,
  concluded: 5,
  finding: 4,
  "scope-approval": 3,
  hint: 2,
  open: 1,
  discarded: 0,
};

/**
 * 按测试域分框：一个域就是画布上的一个大方框，属于该域的 Step / Fact / Finding
 * 作为真实节点放在框里。起点、范围、目标与提示仍是框外的锚点。
 *
 * 这样做的取舍：
 * - 域内连线不再逐条画出来，只在框头写「组内 N 条关联」，避免同一张卡里线线相交；
 * - 跨域连线提升到框与框之间，并标「N 条关联」，让「哪个域依赖哪个域」一眼可见；
 * - 所有节点保留真实 id，点选、详情、定位和回放仍按原节点工作。
 *
 * 布局是确定性的两列卡片，不交给 dagre/ELK：域框大小随成员数量变化，
 * 力导向或分层布局会把框和框内节点重新拆散，正是之前「整理连线」后错乱的原因。
 */
export function domainSummaryElements(elements: ElementDefinition[], graph: Graph): ElementDefinition[] {
  const nodes = elements.filter((el) => !isEdge(el));
  const edges = elements.filter(isEdge);
  const { domainOf } = domainIndex(graph);
  const nodeType = new Map<string, string>(
    nodes.map((node) => [nodeIdOf(node), String((node.data as any).type || "fact")]),
  );

  const groups = new Map<string, { domain: string; members: ElementDefinition[] }>();
  const anchors: ElementDefinition[] = [];
  const assignment = new Map<string, { domain: string; focus?: string }>();
  for (const node of nodes) {
    const id = nodeIdOf(node);
    const type = nodeType.get(id)!;
    const value = domainOf(id, type);
    if (!value) {
      anchors.push(node);
      continue;
    }
    assignment.set(id, value);
    const group = groups.get(value.domain);
    if (group) group.members.push(node);
    else groups.set(value.domain, { domain: value.domain, members: [node] });
  }

  // 组内连线只计数：同一张卡里的因果线会让卡片变成一团线。
  const internal = new Map<string, number>();
  for (const edge of edges) {
    const data = edge.data as any;
    const sourceDomain = assignment.get(String(data.source))?.domain;
    const targetDomain = assignment.get(String(data.target))?.domain;
    if (sourceDomain && sourceDomain === targetDomain) {
      internal.set(sourceDomain, (internal.get(sourceDomain) ?? 0) + 1);
    }
  }

  const order = (domain: string) => {
    const index = DOMAIN_ORDER.indexOf(domain);
    return index < 0 ? DOMAIN_ORDER.length : index;
  };
  const sorted = [...groups.values()].sort((a, b) => order(a.domain) - order(b.domain));

  interface Card {
    domain: string;
    label: string;
    width: number;
    height: number;
    header: number;
    columns: number;
    steps: ElementDefinition[];
    outputs: ElementDefinition[];
    stepHeight: number;
    stepCapacity: number;
    outputColumns: number;
    left: number;
    top: number;
  }

  const cards: Card[] = sorted.map((group) => {
    const count = group.members.length;
    const typeOfNode = (node: ElementDefinition) => String((node.data as any).type || "");
    const typeCount = (type: string) => group.members.filter((node) => typeOfNode(node) === type).length;
    const stepCount = typeCount("step");
    const facts = typeCount("fact");
    const findings = typeCount("finding");
    const parts = [
      stepCount ? `任务 ${stepCount}` : "",
      facts ? `事实 ${facts}` : "",
      findings ? `发现 ${findings}` : "",
    ].filter(Boolean);
    const lines = [`${DOMAIN_LABEL[group.domain] || group.domain} · ${count} 个节点`];
    if (parts.length) lines.push(parts.join(" · "));

    const extras: string[] = [];
    if (group.domain === "post") {
      const prefixes = new Map<string, number>();
      for (const node of group.members) {
        const focus = assignment.get(nodeIdOf(node))?.focus;
        const prefix = focusPrefix(focus);
        if (prefix !== "其他") prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
      if (prefixes.size) {
        extras.push(
          [...prefixes]
            .sort((a, b) => (POST_FOCUS_ORDER.indexOf(a[0]) + 1 || 99) - (POST_FOCUS_ORDER.indexOf(b[0]) + 1 || 99))
            .map(([prefix, value]) => `${prefix} ${value}`)
            .join(" · "),
        );
      }
    }
    const internalEdges = internal.get(group.domain) ?? 0;
    if (internalEdges) extras.push(`组内 ${internalEdges} 条关联`);
    if (extras.length) lines.push(extras.join(" · "));

    const ordered = [...group.members].sort((a, b) => {
      const at = MEMBER_ORDER.indexOf(typeOfNode(a));
      const bt = MEMBER_ORDER.indexOf(typeOfNode(b));
      return (at < 0 ? 99 : at) - (bt < 0 ? 99 : bt) || nodeIdOf(a).localeCompare(nodeIdOf(b));
    });
    const stepNodes = ordered.filter((node) => typeOfNode(node) === "step");
    const outputNodes = ordered.filter((node) => typeOfNode(node) !== "step");
    const columns = cardColumns(count);
    const width = cardWidth(columns);
    // 框头也要按实际字宽换行；否则窄框的第二行会折成两行，压到第一排节点上。
    const fitted = fitNodeLabel(lines.join("\n"), ((width - 24) * CARD.titleBaseFont) / CARD.titleFont, 4);
    const header = CARD.headerPad + fitted.lines * CARD.headerLine;
    const stepCapacity = Math.max(
      1,
      Math.floor((width - CARD.pad * 2 + CARD.stepGap) / (CARD.stepCell + CARD.stepGap)),
    );
    const stepRows = stepNodes.length ? Math.ceil(stepNodes.length / stepCapacity) : 0;
    const stepHeight = stepRows ? stepRows * CARD.stepCell + (stepRows - 1) * CARD.stepGap : 0;
    const outputColumns = outputNodes.length ? Math.min(columns, outputNodes.length) : 0;
    const outputRows = outputColumns ? Math.ceil(outputNodes.length / outputColumns) : 0;
    const outputHeight = outputRows ? outputRows * CARD.nodeHeight + (outputRows - 1) * CARD.gap : 0;
    const contentHeight = stepHeight + (stepHeight && outputHeight ? CARD.gap : 0) + outputHeight;
    return {
      domain: group.domain,
      label: fitted.label,
      width,
      height: header + contentHeight + CARD.pad,
      header,
      columns,
      steps: stepNodes,
      outputs: outputNodes,
      stepHeight,
      stepCapacity,
      outputColumns,
      left: 0,
      top: 0,
    };
  });

  // 锚点先排在上方：起点 / 目标 / 范围 / 提示不参与测试域，不能被塞进某个框里。
  const anchorOrder = (node: ElementDefinition) => {
    const type = String((node.data as any).type || "");
    const index = ANCHOR_ORDER.indexOf(type);
    return index < 0 ? ANCHOR_ORDER.length : index;
  };
  const sortedAnchors = [...anchors].sort(
    (a, b) => anchorOrder(a) - anchorOrder(b) || nodeIdOf(a).localeCompare(nodeIdOf(b)),
  );
  const anchorRows: ElementDefinition[][] = [];
  for (let i = 0; i < sortedAnchors.length; i += ANCHORS_PER_ROW) {
    anchorRows.push(sortedAnchors.slice(i, i + ANCHORS_PER_ROW));
  }
  const anchorWidth = (node: ElementDefinition) => ANCHOR_WIDTH[String((node.data as any).type || "")] || 164;
  const anchorHeight = (node: ElementDefinition) => Number((node.data as any).height) || 46;

  // 卡片按域顺序排成网格：1–2 张单/双列，3–4 张双列，更多用三列，
  // 让 6 个域时形成 2 行而不是 3 行，初始适应窗口后仍能看清整张图。
  const colCount = cards.length > 1 ? (cards.length <= 4 ? 2 : 3) : cards.length;
  const colWidth = cards.reduce((max, card) => Math.max(max, card.width), 0);
  const gridWidth = colCount * colWidth + Math.max(0, colCount - 1) * CARD.cardGap;
  let cursorY = 0;
  for (let i = 0; i < cards.length; i += colCount) {
    const row = cards.slice(i, i + colCount);
    row.forEach((card, col) => {
      card.left = col * (colWidth + CARD.cardGap);
      card.top = cursorY;
    });
    cursorY += Math.max(...row.map((card) => card.height)) + CARD.rowGap;
  }

  let anchorBottom = 0;
  if (anchorRows.length) {
    let y = 0;
    for (const row of anchorRows) {
      const rowWidth = row.reduce((sum, node) => sum + anchorWidth(node), 0) + (row.length - 1) * CARD.anchorGap;
      let x = (gridWidth - rowWidth) / 2;
      for (const node of row) {
        const width = anchorWidth(node);
        (node as any).position = { x: x + width / 2, y: y + anchorHeight(node) / 2 };
        x += width + CARD.anchorGap;
      }
      y += Math.max(...row.map(anchorHeight)) + CARD.anchorRowGap;
    }
    anchorBottom = y - CARD.anchorRowGap;
  }

  const domainTop = anchorBottom > 0 ? anchorBottom + CARD.domainTop : 0;
  const frameNodes: ElementDefinition[] = [];
  const memberNodes: ElementDefinition[] = [];
  const grouped = new Map<string, string>();

  for (const card of cards) {
    const frameId = domainNodeId(card.domain);
    frameNodes.push({
      position: {
        x: card.left + card.width / 2,
        y: domainTop + card.top + card.height / 2,
      },
      data: {
        id: frameId,
        label: card.label,
        type: "summary",
        summaryKind: "domain",
        frame: 1,
        groupType: frameId,
        domain: card.domain,
        count: card.steps.length + card.outputs.length,
        internal: internal.get(card.domain) ?? 0,
        width: card.width,
        height: card.height,
        labelWidth: card.width - 24,
        // 标题块中心对齐到卡片 header 的中心；配合样式里的 text-valign:center，
        // 标题才会落在框内而不是框外。
        labelOffsetY: -card.height / 2 + card.header / 2,
      },
    });

    const contentTop = domainTop + card.top + card.header;
    // 任务保持圆圈「?」，按紧凑格子排在卡片顶部；多行时每行单独居中。
    card.steps.forEach((node, index) => {
      const row = Math.floor(index / card.stepCapacity);
      const col = index % card.stepCapacity;
      const countInRow = Math.min(card.stepCapacity, card.steps.length - row * card.stepCapacity);
      const rowWidth = countInRow * CARD.stepCell + (countInRow - 1) * CARD.stepGap;
      const rowLeft = card.left + (card.width - rowWidth) / 2;
      const stepNode: ElementDefinition = {
        ...node,
        position: {
          x: rowLeft + col * (CARD.stepCell + CARD.stepGap) + CARD.stepCell / 2,
          y: contentTop + row * (CARD.stepCell + CARD.stepGap) + CARD.stepCell / 2,
        },
        data: { ...(node.data as any), group: card.domain },
      };
      grouped.set(nodeIdOf(stepNode), frameId);
      memberNodes.push(stepNode);
    });

    if (card.outputs.length) {
      const outputTop = contentTop + card.stepHeight + (card.stepHeight ? CARD.gap : 0);
      const outputWidth = card.outputColumns * CARD.nodeWidth + (card.outputColumns - 1) * CARD.gap;
      const outputLeft = card.left + (card.width - outputWidth) / 2;
      card.outputs.forEach((node, index) => {
        const row = Math.floor(index / card.outputColumns);
        const col = index % card.outputColumns;
        const compact = compactGroupedNode(node, card.domain, assignment.get(nodeIdOf(node))?.focus);
        (compact as any).position = {
          x: outputLeft + col * (CARD.nodeWidth + CARD.gap) + CARD.nodeWidth / 2,
          y: outputTop + row * (CARD.nodeHeight + CARD.gap) + CARD.nodeHeight / 2,
        };
        grouped.set(nodeIdOf(compact), frameId);
        memberNodes.push(compact);
      });
    }
  }

  const nodesOut = [...frameNodes, ...sortedAnchors, ...memberNodes];

  // 跨域连线提升到框级别；域内连线已在上面的 internal 计数里。
  const aggregated = new Map<string, { source: string; target: string; status: string; count: number }>();
  const kept: ElementDefinition[] = [];
  const present = new Set(nodesOut.map(nodeIdOf));
  for (const edge of edges) {
    const data = edge.data as any;
    const source = String(data.source);
    const target = String(data.target);
    if (!present.has(source) || !present.has(target)) continue;
    const sourceGroup = grouped.get(source) ?? source;
    const targetGroup = grouped.get(target) ?? target;
    if (sourceGroup === targetGroup) continue;
    // 两端都是框外锚点：保留原边，范围批准、目标达成等锚点关系仍有方向。
    if (!grouped.has(source) && !grouped.has(target)) {
      kept.push(edge);
      continue;
    }
    const status = String(data.status || "");
    const key = `${sourceGroup}\u0000${targetGroup}`;
    const current = aggregated.get(key);
    if (current) {
      current.count += 1;
      if ((STATUS_RANK[status] ?? -1) > (STATUS_RANK[current.status] ?? -1)) current.status = status;
    } else {
      aggregated.set(key, { source: sourceGroup, target: targetGroup, status, count: 1 });
    }
  }

  const linkEdges: ElementDefinition[] = [];
  for (const edge of aggregated.values()) {
    linkEdges.push({
      data: {
        id: `${EDGE_PREFIX}${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        status: edge.status,
        label: edge.count > 1 ? `${edge.count} 条关联` : "",
        count: edge.count,
        type: "summary",
      },
    });
  }

  return finishElements(nodesOut, [...linkEdges, ...kept]);
}
