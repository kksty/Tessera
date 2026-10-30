import type { Graph, Step } from "../../protocol/src/index.js";

/**
 * A Step is claimable only after every prerequisite has produced its result.
 *
 * "Produced" means the prerequisite actually ran (`executed_at`). A close
 * without execution (for example a waived direction) is not a premise: the
 * successor would otherwise run on a Fact that never existed. A discarded or
 * deleted prerequisite, or a dangling ID, keeps the chain blocked as well.
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

/** All live Steps that directly depend on one of the given IDs. */
export function dependentSteps(graph: Graph, ids: Set<string>): Step[] {
  return graph.steps.filter(
    (step) => !step.deleted && (step.depends_on ?? []).some((dependency) => ids.has(dependency)),
  );
}
