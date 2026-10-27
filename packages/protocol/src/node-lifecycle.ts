import type { DeletedNodeRef, Graph } from "./models.js";
import { resolveGraphRelations } from "./graph-relations.js";
import { findingAssets, stepAssets } from "./asset-scope.js";

export const isActiveNode = (node: { deleted?: unknown }) => !node.deleted;
export const graphNodeKinds = ["facts", "steps", "findings", "goals"] as const;

/** Every graph record that can own an Evidence reference. Nested claims are included
 *  because parameter provenance, impact evidence and the completion table also cite originals. */
export type EvidenceRecord = {
  evidence_ids?: readonly string[];
  parameter_sources?: readonly { evidence_ids?: readonly string[] }[];
  cvss?: { impact_evidence?: readonly { evidence_ids?: readonly string[] }[] } | null;
  completion?: {
    coverage?: readonly { evidence_ids?: readonly string[] }[];
    review_issues?: readonly { evidence_ids?: readonly string[] }[];
  } | null;
};

export function recordEvidenceIds(record: EvidenceRecord): Set<string> {
  const ids = new Set<string>();
  const add = (values?: readonly string[]) => {
    for (const id of values ?? []) ids.add(id);
  };
  add(record.evidence_ids);
  for (const source of record.parameter_sources ?? []) add(source.evidence_ids);
  for (const claim of record.cvss?.impact_evidence ?? []) add(claim.evidence_ids);
  for (const entry of record.completion?.coverage ?? []) add(entry.evidence_ids);
  for (const entry of record.completion?.review_issues ?? []) add(entry.evidence_ids);
  return ids;
}

/** Evidence is the originals the active blackboard cites, not every archived tool trace.
 *  Parts are included only when their manifest is itself referenced. */
export function collectReferencedEvidence(
  records: readonly EvidenceRecord[],
  evidence: readonly { id: string; part_ids?: string[] }[],
): Set<string> {
  const references = new Set<string>();
  for (const record of records) for (const id of recordEvidenceIds(record)) references.add(id);
  if (!evidence.some((item) => item.part_ids?.length)) return references;
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const queue = [...references];
  for (let index = 0; index < queue.length; index += 1)
    for (const part of byId.get(queue[index])?.part_ids ?? [])
      if (!references.has(part)) {
        references.add(part);
        queue.push(part);
      }
  return references;
}
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
  const removed = new Set(refs.map((ref) => ref.id));
  const relations = refs.length ? resolveGraphRelations(graph) : null;
  const retained = (node: { id: string; deleted?: unknown }) => isActiveNode(node) && !removed.has(node.id);
  const facts = graph.facts.filter(retained);
  const findings = graph.findings.filter(retained);
  const reviews = graph.reviews.filter((review) => !removed.has(review.finding_id));
  const steps = graph.steps.filter(retained);
  // Evidence is a claim's original, not every archived tool trace. Unreferenced
  // files stay in the project workspace; an explicit evidence ID remains readable
  // through the content endpoint even after its last owner is deleted.
  const cited: EvidenceRecord[] = [
    ...facts,
    ...findings,
    ...reviews,
    ...graph.assets,
    ...(graph.leads ?? []),
    ...steps,
  ];
  // A completion proposal is still on the project until Review accepts it; its
  // coverage table cites originals that must stay readable while it is pending.
  if (graph.project.pending_completion) cited.push({ completion: graph.project.pending_completion });
  const references = collectReferencedEvidence(cited, graph.evidence);
  const production_sources = { ...graph.production_sources };
  const inherited_asset_ids = { ...graph.inherited_asset_ids };
  if (relations) {
    for (const step of steps) inherited_asset_ids[step.id] = stepAssets(graph, step);
    for (const finding of findings) inherited_asset_ids[finding.id] = findingAssets(graph, finding);
    for (const fact of facts) {
      const producers = relations.facts.get(fact.id)?.producers ?? [];
      if (producers.some((p) => removed.has(p.step_id))) production_sources[fact.id] = producers;
    }
  }
  const evidence = graph.evidence.filter((e) => references.has(e.id));
  const relationIndex = relations;
  const stepView = relationIndex
    ? steps.map((step) => {
        const outputs = (relationIndex.downstream.get(step.id) ?? [])
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
      })
    : steps;
  const visibleIds = new Set(
    [
      ...facts,
      ...findings,
      ...reviews,
      ...evidence,
      ...graph.assets,
      ...graph.hints,
      ...(graph.leads ?? []),
      ...steps,
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
    steps: stepView,
    evidence,
    bookmarks: graph.bookmarks?.filter((bookmark) => visibleIds.has(bookmark.node_id)),
  };
}
