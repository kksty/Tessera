export const closeoutReads = ["read_graph", "read_evidence", "read_workspace"];
export const closeoutWrites = ["save_evidence", "submit_fact", "submit_finding"];

/**
 * Closeout keeps only one gate: no world tools, no new exploration. There is no
 * app-side count or character budget; the task deadline is the only limit.
 */
export function admitCloseoutTool(
  name: string,
  args: Record<string, unknown>,
  repairOnly = false,
): string | undefined {
  const read = closeoutReads.includes(name);
  if (!read && (repairOnly || !closeoutWrites.includes(name)))
    return "Closeout permits only existing-material reads and permitted submissions";
  if (name === "read_graph" && !args.id)
    return "Closeout graph reads require an existing record id";
  return undefined;
}
