import type { Graph, Asset, Evidence, Fact, Finding, Review, Step, DeletedNodeRef } from "../../protocol/src/index.js";
import { resolveGraphRelations, indexRelations, walkRelations, type GraphRelation } from "../../protocol/src/graph-relations.js";
import { confirmedFinding, informationalFinding } from "./overview.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
export interface Material {
  project: { id: string; title: string };
  origin: string;
  goal: string;
  scope: Asset[];
  findings: Finding[];
  reviews: Review[];
  facts: Fact[];
  evidence: Evidence[];
  trace: { relations: GraphRelation[]; steps: Pick<Step, "id" | "description" | "from" | "graph_id">[]; deleted_sources?: DeletedNodeRef[] };
  excluded: { pending: number; rejected: number; informational: number };
}

export function reportMaterial(g: Graph): Material {
    g = activeGraph(g);
    // 报告正文只收已确认漏洞；信息类发现单独计数，不按漏洞交付。
    const findings = g.findings.filter(f => confirmedFinding(f, g) && !informationalFinding(f))
      .map(f => {
        const { review_worker, review_heartbeat, retry_at, last_referenced_round, last_read_round, cooldown_override, ...record } = f;
        return record;
      });
    const reviews = g.reviews.filter(r => r.verdict === "pass" && findings.some(f => f.id === r.finding_id && f.version === r.finding_version));
    const ancestry = findings.length ? walkRelations(resolveGraphRelations(g), findings.map(f => f.id), "sources")
      : { depths: new Map<string, number>(), relations: [] };
    const facts = g.facts.filter(f => ancestry.depths.has(f.id))
      .map(({ last_referenced_round, last_read_round, cooldown_override, ...record }) => record);
    const steps = g.steps.filter(s => ancestry.depths.has(s.id)).map(s => ({
      id: s.id, description: s.description, from: s.from, graph_id: s.graph_id,
    }));
    const ids = new Set([...findings.flatMap(f => f.evidence_ids), ...reviews.flatMap(r => r.evidence_ids), ...facts.flatMap(f => f.evidence_ids)]);
    const queue = [...ids];
    for (let i = 0; i < queue.length; i++) for (const part of g.evidence.find(e => e.id === queue[i])?.part_ids || []) if (!ids.has(part)) { ids.add(part); queue.push(part); }
    return {
      project: { id: g.project.id, title: g.project.title },
      origin: g.facts.find(f => f.id === "origin")?.description || "",
      goal: g.goals.find(goal => goal.id === "goal")?.description || "",
      scope: g.assets.filter(a => a.approval === "approved"), findings, reviews, facts,
      evidence: g.evidence.filter(e => ids.has(e.id))
        .map(({ last_referenced_round, last_read_round, cooldown_override, ...record }) => record),
      trace: { relations: ancestry.relations, steps,
        ...(g.deleted_nodes?.length ? { deleted_sources: g.deleted_nodes.filter(ref => ancestry.depths.has(ref.id)) } : {}) },
      excluded: {
        pending: g.findings.filter(f => !f.merged_into && !f.withdrawn_at && f.review_status !== "rejected" && !findings.some(v => v.id === f.id) && !(confirmedFinding(f, g) && informationalFinding(f))).length,
        rejected: g.findings.filter(f => f.review_status === "rejected").length,
        informational: g.findings.filter(f => confirmedFinding(f, g) && informationalFinding(f)).length,
      },
    };
}

/** The same frozen causal chain is rendered in Markdown and the web preview. */
export function findingTrace(material: Material, findingId: string) {
  const ancestry = walkRelations(indexRelations(material.trace.relations), [findingId], "sources");
  return { facts: material.facts.filter(f => ancestry.depths.has(f.id)),
    steps: material.trace.steps.filter(s => ancestry.depths.has(s.id)), relations: ancestry.relations,
    deleted_sources: material.trace.deleted_sources?.filter(ref => ancestry.depths.has(ref.id)) ?? [] };
}
