import type { Graph } from "../../protocol/src/index.js";

/**
 * A Lead is only answered while the Step it was converted to can still do the
 * work. Whenever a Step is discarded or deleted, its converted Leads must go
 * back to the open list: otherwise the checklist still counts the question as
 * answered even though nothing is left to answer it.
 *
 * Keeping this transition in one place matters because Steps can be retired by
 * Decide, an operator discard, Hint edits, origin rewrites, asset revocation or
 * deletion. A missed path leaves an invisible converted Lead that blocks
 * completion and can no longer be dispositioned.
 */
export function reopenLeadsForStep(graph: Graph, stepId: string): void {
  for (const lead of graph.leads ?? [])
    if (lead.status === "converted" && lead.converted_step_id === stepId) {
      lead.status = "open";
      lead.converted_step_id = undefined;
      lead.disposition_at = undefined;
      lead.disposition_by = undefined;
    }
}
