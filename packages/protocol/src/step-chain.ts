import type { Graph, Step } from "./models.js";

/**
 * A Step is claimable only after every prerequisite has produced its result.
 *
 * "Produced" means the prerequisite actually ran (`executed_at`). A close
 * without execution (for example a waived direction) is not a premise: the
 * successor would otherwise run on a Fact that never existed. A discarded or
 * deleted prerequisite, or a dangling ID, keeps the chain blocked as well.
 *
 * This module stays protocol-only so Server, Runner and the browser share one
 * interpretation of the chain state.
 */
export function unmetDependencies(graph: Graph, step: Pick<Step, "depends_on">): string[] {
  return (step.depends_on ?? []).filter((id) => {
    const dependency = graph.steps.find((candidate) => candidate.id === id);
    if (!dependency || dependency.deleted || dependency.discarded) return true;
    return !dependency.executed_at;
  });
}

export function dependenciesReady(graph: Graph, step: Pick<Step, "depends_on">): boolean {
  return unmetDependencies(graph, step).length === 0;
}

/**
 * A chain may continue without another planning round only when every premise
 * produced a positive observation. A negative or empty result means the
 * premise did not materialise; Decide must judge whether to rewrite or discard
 * the successor instead of letting it run on a gap.
 */
export function chainPremiseObserved(graph: Graph, step: Pick<Step, "depends_on">): boolean {
  if (!step.depends_on?.length) return false;
  return step.depends_on.every((id) => {
    const dependency = graph.steps.find((candidate) => candidate.id === id);
    if (!dependency || dependency.deleted || dependency.discarded || !dependency.executed_at) return false;
    return dependency.fact_ids.some((factId) => {
      const fact = graph.facts.find((candidate) => candidate.id === factId);
      return !!fact && !fact.deleted && (fact.status ?? "observed") === "observed";
    });
  });
}

/** All live Steps that directly depend on one of the given IDs. */
export function dependentSteps(graph: Graph, ids: Set<string>): Step[] {
  return graph.steps.filter(
    (step) => !step.deleted && (step.depends_on ?? []).some((dependency) => ids.has(dependency)),
  );
}
