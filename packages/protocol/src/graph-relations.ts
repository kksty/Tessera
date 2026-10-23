import type { Graph } from "./models.js";

/** Edges point from a prerequisite/material to the record that consumes it. */
export interface GraphRelation {
  source: string;
  target: string;
  kind: "step_input" | "fact_production" | "finding_source" | "finding_production" |
    "evidence_reference" | "review" | "bookmark";
  /** Only a recorded Fact production identifies its Run; never use Step.run_id here. */
  run_id?: string;
  inferred?: boolean;
  ambiguous?: boolean;
  finding_version?: number;
  source_deleted?: boolean;
  target_deleted?: boolean;
}

export interface FactProvenance {
  producers: { step_id: string; run_id?: string; inferred: boolean }[];
  ambiguous: boolean;
}

export const relationLabels: Record<GraphRelation["kind"], string> = {
  step_input: "输入依赖", fact_production: "生产事实", finding_source: "来源事实",
  finding_production: "产出发现", evidence_reference: "证据引用", review: "审核版本", bookmark: "书签",
};

export function indexRelations(relations: GraphRelation[]) {
  const upstream = new Map<string, GraphRelation[]>(), downstream = new Map<string, GraphRelation[]>();
  for (const edge of relations) {
    const parents = upstream.get(edge.target) ?? [];
    parents.push(edge); upstream.set(edge.target, parents);
    const children = downstream.get(edge.source) ?? [];
    children.push(edge); downstream.set(edge.source, children);
  }
  return { relations, upstream, downstream };
}
export type RelationIndex = ReturnType<typeof indexRelations>;

/** Shared by queries, task views, the board and report snapshots; no graph writes. */
export function resolveGraphRelations(graph: Graph) {
  const deleted = new Set([...(graph.deleted_nodes ?? []).map(node => node.id),
    ...[...graph.facts, ...graph.steps, ...graph.findings, ...graph.goals].filter(node => node.deleted).map(node => node.id)]);
  const facts = new Map<string, FactProvenance>(), edges = new Map<string, GraphRelation>();
  const add = (edge: GraphRelation) => {
    if (edge.source && edge.target && edge.source !== "goal")
      edges.set(JSON.stringify([edge.kind, edge.source, edge.target]), { ...edge,
        ...(deleted.has(edge.source) ? { source_deleted: true } : {}),
        ...(deleted.has(edge.target) ? { target_deleted: true } : {}) });
  };
  for (const fact of graph.facts) {
    const producers: FactProvenance["producers"] = graph.production_sources?.[fact.id] ?? (fact.step_id
      ? [{ step_id: fact.step_id, ...(fact.run_id ? { run_id: fact.run_id } : {}), inferred: false }]
      : []);
    const ambiguous = producers.length > 1;
    facts.set(fact.id, { producers, ambiguous });
    for (const producer of producers) add({ source: producer.step_id, target: fact.id, kind: "fact_production",
      ...(producer.run_id ? { run_id: producer.run_id } : {}),
      ...(producer.inferred ? { inferred: true } : {}), ...(ambiguous ? { ambiguous: true } : {}) });
    for (const id of fact.evidence_ids) add({ source: id, target: fact.id, kind: "evidence_reference" });
  }
  for (const step of graph.steps)
    for (const id of step.from) add({ source: id, target: step.id, kind: "step_input" });
  for (const finding of graph.findings) {
    for (const id of finding.from) add({ source: id, target: finding.id, kind: "finding_source" });
    for (const id of finding.evidence_ids) add({ source: id, target: finding.id, kind: "evidence_reference" });
    for (const id of new Set([finding.step_id, finding.revision_step_id]))
      if (id) add({ source: id, target: finding.id, kind: "finding_production" });
  }
  for (const review of graph.reviews) {
    add({ source: review.finding_id, target: review.id, kind: "review", finding_version: review.finding_version });
    for (const id of review.evidence_ids) add({ source: id, target: review.id, kind: "evidence_reference" });
  }
  for (const asset of graph.assets)
    for (const id of asset.evidence_ids) add({ source: id, target: asset.id, kind: "evidence_reference" });
  for (const bookmark of graph.bookmarks ?? []) add({ source: bookmark.node_id, target: bookmark.id, kind: "bookmark" });
  const relations = [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  return { ...indexRelations(relations), facts };
}

/** Breadth-first, shortest distances, seed exclusion and a visited set even on cyclic legacy graphs. */
export function walkRelations(index: RelationIndex, seeds: string[], direction: "sources" | "outputs", depth = Infinity) {
  const visited = new Set(seeds), depths = new Map<string, number>(), traversed = new Set<GraphRelation>();
  const queue: [string, number][] = [...visited].map(id => [id, 0]);
  const links = direction === "sources" ? index.upstream : index.downstream;
  for (let offset = 0; offset < queue.length; offset++) {
    const [id, distance] = queue[offset];
    if (distance >= depth) continue;
    for (const edge of links.get(id) ?? []) {
      traversed.add(edge);
      const next = direction === "sources" ? edge.source : edge.target;
      if (visited.has(next)) continue;
      visited.add(next); depths.set(next, distance + 1); queue.push([next, distance + 1]);
    }
  }
  return { depths, relations: index.relations.filter(edge => traversed.has(edge)) };
}
