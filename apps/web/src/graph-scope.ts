import type { ElementDefinition } from "cytoscape";
import { recordEvidenceIds } from "../../../packages/protocol/src/index.js";
import type { Event, EvidenceRecord, Graph } from "../../../packages/protocol/src/index.js";
import { changedIds } from "./replay.js";

/** 显式范围：黑板只画「这条链路」——从这个节点往上追到起点、往下追到结论。
 *  label 是画布上的范围提示（例如「发现 v003」）；缺省时由节点类型推导。 */
export interface GraphScope {
  ids: string[];
  label?: string;
}

/** 链路深度：0 表示完整链路（一路追到起点/结论）。 */
export const SCOPE_FULL = 0;

/** 范围种子只来自显式范围：主视图里的选中不改变画布范围。 */
export function scopeSeeds(scope?: GraphScope | null): string[] {
  return (scope?.ids ?? []).filter(Boolean);
}

/** 链路：只沿有向边取「来路」——从种子一路向前驱追到起点。
 *  这就是 FGS 的因果链：「开始 → 当前节点」；漏洞的链路就是它的全部证据来路。
 *  只保留两端都在集合里的连线，因此画布上永远是一张连起来的图；
 *  Step 入口额外显示它直接产出的第一层节点；不展开后续任务或其他分支。 */
export function chainElements(elements: ElementDefinition[], seeds: string[], hops = SCOPE_FULL): ElementDefinition[] {
  const isEdge = (el: ElementDefinition) => typeof (el.data as any).source === "string";
  const known = new Set<string>();
  for (const el of elements) if (!isEdge(el)) known.add(String(el.data.id));
  const wanted = seeds.filter((id) => known.has(id));
  if (!wanted.length) return elements;

  const incoming = new Map<string, string[]>();
  for (const el of elements) {
    const data = el.data as any;
    if (!isEdge(el) || !known.has(data.source) || !known.has(data.target)) continue;
    const list = incoming.get(data.target);
    if (list) list.push(data.source);
    else incoming.set(data.target, [data.source]);
  }

  const limit = hops > 0 ? hops : Number.POSITIVE_INFINITY;
  const keep = new Set<string>(wanted);
  const queue: Array<[string, number]> = wanted.map((id) => [id, 0]);
  while (queue.length) {
    const [id, depth] = queue.shift()!;
    if (depth >= limit) continue;
    for (const next of incoming.get(id) ?? [])
      if (!keep.has(next)) {
        keep.add(next);
        queue.push([next, depth + 1]);
      }
  }
  // 任务入口额外保留它直接产生的一层节点，不递归展开后续任务。
  const stepSeeds = new Set(
    elements
      .filter((el) => !isEdge(el) && el.data.type === "step" && wanted.includes(String(el.data.id)))
      .map((el) => String(el.data.id)),
  );
  for (const el of elements)
    if (isEdge(el) && stepSeeds.has(String(el.data.source)) && known.has(String(el.data.target)))
      keep.add(String(el.data.target));
  return elements.filter((el) => {
    const data = el.data as any;
    return isEdge(el) ? keep.has(data.source) && keep.has(data.target) : keep.has(String(data.id));
  });
}

export function scopeSize(elements: ElementDefinition[]) {
  let nodes = 0;
  for (const el of elements) if (typeof (el.data as any).source !== "string") nodes++;
  return { nodes, edges: elements.length - nodes };
}

/** 发现：从这条结论往回追，整整一条证据链（起点 → 这条漏洞）。 */
export function scopeForFinding(_graph: Graph, findingId: string): GraphScope {
  return {
    ids: [findingId],
    label: `发现链路 ${findingId} · 起点到这条漏洞`,
  };
}

/** 任意节点：从起点一路追到它。 */
export function scopeForNode(graph: Graph, nodeId: string): GraphScope {
  return {
    ids: [nodeId],
    label: graph.steps.some((s) => s.id === nodeId)
      ? `任务链路 ${nodeId} · 来路与直接产出`
      : `链路 ${nodeId} · 起点到这里`,
  };
}

/** 证据：所有引用它的观测、候选结论、审核与完成记录，各自展开成链路。
 *  审核只通过被审 Finding 回到黑板；资产与 Lead 没有独立画布节点。 */
export function scopeForEvidence(graph: Graph, evidenceId: string): GraphScope {
  const cites = (record: EvidenceRecord) => recordEvidenceIds(record).has(evidenceId);
  const facts = graph.facts.filter(cites);
  const findings = graph.findings.filter(cites);
  const reviews = graph.reviews.filter(cites);
  const steps = graph.steps.filter(cites);
  const reviewFindings = reviews
    .map((review) => review.finding_id)
    .filter((id) => graph.findings.some((finding) => finding.id === id));
  const ids = [
    ...new Set([
      ...facts.map((fact) => fact.id),
      ...findings.map((finding) => finding.id),
      ...reviewFindings,
      ...steps.map((step) => step.id),
    ]),
  ];
  return {
    ids,
    label: `证据 ${evidenceId} · 引用它的链路`,
  };
}

/** 一条事件真正改动过的节点。回放只把它选中并居中，不改变画布范围 ——
 *  图始终是总视图，链路视图只能由显式入口进入。 */
export function eventTargets(graph: Graph, event: Event): string[] {
  const known = new Set<string>(
    [...graph.facts, ...graph.steps, ...graph.goals, ...graph.findings, ...graph.hints].map((item) => item.id),
  );
  return [...new Set(changedIds(event.data.changes))].filter((id) => known.has(id));
}
