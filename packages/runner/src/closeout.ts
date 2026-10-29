export const closeoutReads = ["read_graph", "read_evidence", "read_workspace", "query_traffic"];
export const closeoutWrites = ["save_evidence", "submit_fact", "submit_finding", "revise_fact"];
/**
 * Cleaning up a shell process is not a world action: `stop` only signals a
 * command this Run started, and `poll` only reads its log. Allow it in closeout
 * and repair so a live command can never trap the Run in the submit-time
 * "still running" failure with no way for the model to end it.
 */
export const processControl = ["process"];
/**
 * A Decide/Review repair is not an Execute closeout: the model still needs its
 * read/search tools to rebuild the projection it is asked to serialize, but it
 * must not commit through a tool while the final JSON is the expected answer.
 */
export const repairReads = [
  ...closeoutReads,
  "query_graph",
  "query_changes",
  "read_change",
  "read_reference",
  "query_references",
];
export function admitRepairTool(name: string): string | undefined {
  if (!repairReads.includes(name) && !processControl.includes(name))
    return "Repair accepts only existing-material reads and shell-process cleanup; return the final JSON without changing state.";
  return undefined;
}

/**
 * Closeout keeps only one gate: no world tools, no new exploration. There is no
 * app-side count or character budget; the task deadline is the only limit.
 */
export function admitCloseoutTool(name: string, args: Record<string, unknown>, repairOnly = false): string | undefined {
  const read = closeoutReads.includes(name) || processControl.includes(name);
  if (!read && (repairOnly || !closeoutWrites.includes(name)))
    return "Closeout permits only existing-material reads, shell-process cleanup and permitted submissions";
  if (name === "read_graph" && !args.id) return "Closeout graph reads require an existing record id";
  return undefined;
}
