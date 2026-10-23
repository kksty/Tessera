import type { DeletedNodeRef, Graph } from "./models.js";
import { resolveGraphRelations } from "./graph-relations.js";
import { findingAssets, stepAssets } from "./asset-scope.js";

export const isActiveNode = (node: { deleted?: unknown }) => !node.deleted;
export const graphNodeKinds = ["facts", "steps", "findings", "goals"] as const;
export function deletedNodeRefs(graph: Graph): DeletedNodeRef[] {
  const refs = new Map((graph.deleted_nodes ?? []).map((ref) => [ref.id, ref]));
  for (const kind of graphNodeKinds)
    for (const node of graph[kind])
      if (node.deleted)
        refs.set(node.id, {
          id: node.id,
          kind,
          deleted_at: node.deleted.at,
          history_ref: `/projects/${encodeURIComponent(graph.project.id)}/fgs/history/${encodeURIComponent(node.id)}`,
        });
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** One default work view. Authorization always uses the durable graph, never this projection. */
export function activeGraph(graph: Graph): Graph {
  const refs = deletedNodeRefs(graph);
  if (!refs.length) return graph;
  const removed = new Set(refs.map((ref) => ref.id));
  const relations = resolveGraphRelations(graph);
  const retained = (node: { id: string; deleted?: unknown }) => isActiveNode(node) && !removed.has(node.id);
  const facts = graph.facts.filter(retained);
  const findings = graph.findings.filter(retained);
  const reviews = graph.reviews.filter((review) => !removed.has(review.finding_id));
  const rawReferences = new Set(
    [...graph.facts, ...graph.findings, ...graph.reviews, ...graph.assets].flatMap((record) => record.evidence_ids),
  );
  const references = new Set(
    [...facts, ...findings, ...reviews, ...graph.assets].flatMap((record) => record.evidence_ids),
  );
  const parts = new Set(graph.evidence.flatMap((e) => e.part_ids ?? []));
  // Evidence with no owners remains browsable. Exclusively deleted owners and their
  // parts leave recommendations/search, while an explicit evidence ID remains readable.
  for (const evidence of graph.evidence)
    if (!rawReferences.has(evidence.id) && !parts.has(evidence.id) && !removed.has(evidence.step_id ?? ""))
      references.add(evidence.id);
  const byId = new Map(graph.evidence.map((e) => [e.id, e]));
  const queue = [...references];
  for (let i = 0; i < queue.length; i++)
    for (const id of byId.get(queue[i])?.part_ids ?? [])
      if (!references.has(id)) {
        references.add(id);
        queue.push(id);
      }
  const production_sources = { ...graph.production_sources };
  const inherited_asset_ids = { ...graph.inherited_asset_ids };
  for (const step of graph.steps.filter(retained)) inherited_asset_ids[step.id] = stepAssets(graph, step);
  for (const finding of findings) inherited_asset_ids[finding.id] = findingAssets(graph, finding);
  for (const fact of facts) {
    const producers = relations.facts.get(fact.id)?.producers ?? [];
    if (producers.some((p) => removed.has(p.step_id))) production_sources[fact.id] = producers;
  }
  const evidence = graph.evidence.filter((e) => references.has(e.id));
  const visibleIds = new Set(
    [
      ...facts,
      ...findings,
      ...reviews,
      ...evidence,
      ...graph.assets,
      ...graph.hints,
      ...(graph.leads ?? []),
      ...graph.steps.filter(retained),
      ...graph.goals.filter(retained),
    ].map((node) => node.id),
  );
  return {
    ...graph,
    deleted_nodes: refs,
    production_sources,
    inherited_asset_ids,
    facts,
    findings,
    reviews,
    goals: graph.goals.filter(retained),
    steps: graph.steps.filter(retained).map((step) => {
      const outputs = (relations.downstream.get(step.id) ?? [])
        .filter((edge) => edge.kind === "fact_production")
        .map((edge) => edge.target);
      const deleted = [
        ...new Set([
          ...(step.deleted_output_ids ?? []),
          ...outputs.filter((id) => removed.has(id)),
          ...step.fact_ids.filter((id) => removed.has(id)),
        ]),
      ];
      if (!deleted.length) return step;
      const fact_ids = step.fact_ids.filter((id) => !removed.has(id));
      return {
        ...step,
        fact_ids,
        deleted_output_ids: deleted,
        to: step.to && removed.has(step.to) ? null : step.to,
        summary: `${fact_ids.length ? "部分" : "全部"}产出已删除；仍有效 Fact：${fact_ids.join(",") || "无"}。原执行摘要见显式历史。`,
      };
    }),
    evidence,
    bookmarks: graph.bookmarks?.filter((bookmark) => visibleIds.has(bookmark.node_id)),
  };
}
