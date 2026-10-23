import type { Finding, Graph, Step } from "./index.js";

/** Every asset a Finding claims to be about, directly or through its current source Step. */
export function findingAssets(graph: Graph, finding: Finding): string[] {
  if (graph.inherited_asset_ids?.[finding.id]) return graph.inherited_asset_ids[finding.id];
  const step = graph.steps.find(s => s.id === (finding.revision_step_id || finding.step_id));
  return [...new Set([...(finding.asset_id ? [finding.asset_id] : []), ...stepAssets(graph, step ?? finding)])];
}

/** Explicit target wins; older unscoped tasks inherit assets through their source facts. */
export function stepAssets(graph: Graph, step: Pick<Step, "asset_id" | "from"> & { id?: string }): string[] {
  if (step.id && graph.inherited_asset_ids?.[step.id]) return graph.inherited_asset_ids[step.id];
  if (step.asset_id) return [step.asset_id];
  const assets = new Set<string>(), seen = new Set<string>(), pending = [...step.from];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const fact = graph.facts.find(f => f.id === id);
    if (fact?.asset_id) { assets.add(fact.asset_id); continue; }
    for (const producer of graph.steps.filter(s => s.fact_ids.includes(id))) {
      if (producer.asset_id) assets.add(producer.asset_id);
      else pending.push(...producer.from);
    }
  }
  return [...assets];
}
