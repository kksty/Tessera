import type { Graph, Step } from "../../protocol/src/index.js";

/** Historical associations only cover the wording that the Step was given. */
export function stepCoversHint(step: Step, hint: Graph["hints"][number]): boolean {
  return !step.deleted && !!step.hint_ids?.includes(hint.id) &&
    (step.hint_versions?.[hint.id] ?? 1) === (hint.version ?? 1);
}

/** One scheduling value shared by the queue and both model projections. */
export function effectiveStepPriority(graph: Graph, step: Step): number {
  return (step.hint_ids ?? []).reduce((priority, id) => {
    const hint = graph.hints.find(h => h.id === id && !h.withdrawn_at && stepCoversHint(step, h));
    return hint ? Math.max(priority, hint.priority ?? 0) : priority;
  }, step.priority);
}
