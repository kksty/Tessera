/**
 * The final Execute payload describes new observations only. A bare node id
 * ("f002"), or text this Run already persisted through submit_fact, refers to
 * something that already exists; writing it again creates a Fact whose body is
 * an identifier and adds planning/settlement noise that Decide has to clean up.
 */
export type FinalFact = string | { description: string };

export type FilteredFacts<F extends FinalFact> = {
  facts: (F | { description: string; evidence_ids: string[] })[];
  filtered: { reference: number; duplicate: number };
};

export function filterFinalFacts<F extends FinalFact>(
  facts: F[],
  knownNodeIds: Iterable<string>,
  recordedDescriptions: Iterable<string>,
): FilteredFacts<F> {
  const known = new Set(knownNodeIds);
  const recorded = new Set([...recordedDescriptions].map(text => text.trim()));
  const filtered = { reference: 0, duplicate: 0 };
  const kept = facts.flatMap<F | { description: string; evidence_ids: string[] }>((fact) => {
    const description = (typeof fact === "string" ? fact : fact.description).trim();
    // A one- or two-letter prefix plus digits is how the graph names its nodes.
    if (typeof fact === "string" && (known.has(description) || /^[a-z]{1,2}\d{1,3}$/i.test(description))) {
      filtered.reference++;
      return [];
    }
    if (recorded.has(description)) {
      filtered.duplicate++;
      return [];
    }
    // Legacy string observations carry no attribution; never guess their evidence.
    return typeof fact === "string" ? [{ description: fact, evidence_ids: [] }] : [fact];
  });
  return { facts: kept, filtered };
}
