import type { Graph } from "./models.js";

/** Revisions are storage watermarks, not counters; legacy rows acknowledge no new planning contract. */
export const planningRevision = (graph: Graph) => graph.planning_revision ?? graph.observation_revision;
export const decidedPlanningRevision = (graph: Graph) => graph.decided_planning_revision ?? 0;
export function searchState(graph: Graph): "exploring" | "reviewing" | "completed" | "paused" {
  if (graph.project.status === "completed") return "completed";
  if (graph.project.status === "stopped") return "paused";
  const pending = graph.project.pending_completion;
  return pending?.planning_revision === planningRevision(graph) &&
    !graph.steps.some(s => !s.deleted && !s.concluded_at && !s.discarded) ? "reviewing" : "exploring";
}
