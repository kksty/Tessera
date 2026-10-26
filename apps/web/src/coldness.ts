import type { Graph } from "../../../packages/protocol/src/index.js";
import { coldView as coreColdView, type ColdView } from "../../../packages/core/src/entry-lines.js";

export {
  HOT_LIMIT_DEFAULT,
  HOT_LIMIT_RECOMMENDED,
  HOT_CHAR_LIMIT_DEFAULT,
} from "../../../packages/core/src/entry-lines.js";

/** One cold view per graph snapshot; the blackboard asks for every node during a render. */
const views = new WeakMap<Graph, ColdView>();

/**
 * The UI must not re-implement the hot/cold budget: nodes and characters decide
 * the same set on the server, and a second copy would drift. The server default
 * `focus` is empty here; a focused entry is only built for a running job.
 *
 * `entry-lines` is protocol-only on purpose: importing `projection.ts` here would
 * pull `node:crypto` through `finding-merges` and break the browser bundle.
 */
export function coldState(graph: Graph): ColdView {
  const cached = views.get(graph);
  if (cached) return cached;
  const view = coreColdView(graph);
  views.set(graph, view);
  return view;
}

export function coldView(graph: Graph): Set<string> {
  return coldState(graph).cold;
}

export function isColdNode(graph: Graph, node: { id: string }, open = false): boolean {
  if (open) return false;
  return coldView(graph).has(node.id);
}

export function coldNodes(graph: Graph) {
  const cold = coldView(graph);
  const result: { kind: string; id: string }[] = [];
  for (const fact of graph.facts)
    if (fact.id !== "origin" && fact.kind !== "navigation" && cold.has(fact.id))
      result.push({ kind: "facts", id: fact.id });
  for (const finding of graph.findings) if (cold.has(finding.id)) result.push({ kind: "findings", id: finding.id });
  return result;
}
