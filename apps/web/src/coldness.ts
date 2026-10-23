import type { Graph } from "../../../packages/protocol/src/index.js";

export const HOT_LIMIT_DEFAULT = 200;

type ColdNode = { id: string; last_referenced_round?: number; last_read_round?: number; cooldown_override?: string };

/** One cold set per graph snapshot; the blackboard asks for every node during a render. */
const views = new WeakMap<Graph, Set<string>>();

/**
 * Same rule as the server: hot = open work + the most recently used Facts/Findings
 * up to `hot_limit`. Only Facts/Findings cool; closed Steps and Evidence are
 * history, neither hot nor cold. 0 disables cooling. Never-used nodes rank last
 * and are marked `未引用` by the server preview.
 */
export function coldView(graph: Graph): Set<string> {
  const cached = views.get(graph);
  if (cached) return cached;
  const limit = Math.max(0, graph.project.hot_limit ?? HOT_LIMIT_DEFAULT);
  const cold = new Set<string>();
  if (limit) {
    const openSteps = new Set(graph.steps.filter(step => !step.concluded_at && !step.discarded).map(step => step.id));
    const candidates: { id: string; last: number; created: string }[] = [];
    const consider = (record: ColdNode & { created_at?: string }, last: number) => {
      if (record.cooldown_override === "pinned") return;
      if (record.cooldown_override === "cooled") { cold.add(record.id); return; }
      candidates.push({ id: record.id, last, created: String(record.created_at ?? "") });
    };
    for (const fact of graph.facts) {
      if (fact.id === "origin" || fact.kind === "navigation") continue;
      consider(fact, Math.max(fact.last_referenced_round ?? -1, fact.last_read_round ?? -1));
    }
    for (const finding of graph.findings) {
      const stepId = finding.step_id ?? finding.revision_step_id;
      if (stepId && openSteps.has(stepId)) continue;
      consider(finding, Math.max(finding.last_referenced_round ?? -1, finding.last_read_round ?? -1));
    }
    candidates.sort((a, b) => b.last - a.last || a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    for (let index = limit; index < candidates.length; index++) cold.add(candidates[index].id);
  }
  views.set(graph, cold);
  return cold;
}

export function isColdNode(graph: Graph, node: { id: string }, open = false): boolean {
  if (open) return false;
  return coldView(graph).has(node.id);
}

export function coldNodes(graph: Graph) {
  const cold = coldView(graph);
  const result: { kind: string; id: string }[] = [];
  for (const fact of graph.facts)
    if (fact.id !== "origin" && fact.kind !== "navigation" && cold.has(fact.id)) result.push({ kind: "facts", id: fact.id });
  for (const finding of graph.findings)
    if (cold.has(finding.id)) result.push({ kind: "findings", id: finding.id });
  return result;
}
