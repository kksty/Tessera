/**
 * A Decide settlement is one model response. When it carries many Finding
 * revisions, the JSON can approach the provider output ceiling (the observed
 * failures were 12–16k tokens, one exactly at 16384). The model should submit
 * those revisions in bounded calls using `more`, but a single call can still
 * grow past the budget through accumulated diffs.
 *
 * This splitter turns that one payload into ordered parts that the server
 * accepts under the same Decide lease:
 *   part 1: plan/step settlement (nothing is replayed in later parts),
 *   parts 2..n: Finding merges and updates, chunked by serialized size,
 *   final part: complete, when the caller is finishing.
 * Each part after the first reuses the committed plan_id and carries the same
 * observation snapshot, so the model does not have to re-read the graph.
 */
export const SETTLEMENT_BATCH_CHARS = 10000;

type Payload = Record<string, unknown>;

const SHARED_KEYS = ["worker", "revision", "observation_revision", "planning_revision", "graph_id", "plan_id"] as const;

const BASE_KEYS = [
  "updates",
  "closes",
  "reopens",
  "goals",
  "assets",
  "hint_notes",
  "lead_dispositions",
  "delete_nodes",
  "deletion_preview_hash",
] as const;

const encodedSize = (value: unknown) => JSON.stringify(value).length;
const list = (value: unknown) => (Array.isArray(value) ? value : []);

function shared(input: Payload) {
  const result: Payload = {};
  for (const key of SHARED_KEYS) if (input[key] !== undefined) result[key] = input[key];
  return result;
}

function base(input: Payload) {
  const result = shared(input);
  result.steps = [];
  for (const key of BASE_KEYS) if (input[key] !== undefined) result[key] = input[key];
  return result;
}

/**
 * Split only settlement fields. Steps always stay in the first part: the
 * Decide contract appends Steps through a plan, not through later settlement
 * parts. Only a plan that alone exceeds the budget stays unsplit (the prompt
 * then asks the model to plan fewer Steps per call).
 */
export function settlementBatches(input: Payload, limit = SETTLEMENT_BATCH_CHARS): Payload[] {
  // Preserve an invalid model payload so the server can explain the contract
  // instead of silently repairing `complete` + `more` during splitting.
  if (input.complete && input.more === true) return [input];
  if (encodedSize(input) <= limit) return [input];
  const steps = list(input.steps);
  if (steps.length && encodedSize({ ...shared(input), steps }) > limit) return [input];
  const merges = list(input.finding_merges);
  const updates = list(input.finding_updates);
  if (!merges.length && !updates.length) return [input];
  const first = { ...base(input), steps };
  const chunks: Payload[] = [];
  let current: Payload = { ...first, finding_merges: [], finding_updates: [] };
  const hasOperations = (part: Payload) =>
    list(part.finding_merges).length > 0 || list(part.finding_updates).length > 0;
  const flush = () => {
    if (hasOperations(current)) chunks.push(current);
    current = { ...shared(input), steps: [], finding_merges: [], finding_updates: [] };
  };
  for (const merge of merges) {
    const candidate = { ...current, finding_merges: [...list(current.finding_merges), merge] };
    if (hasOperations(current) && encodedSize(candidate) > limit) {
      flush();
      current = { ...current, finding_merges: [...list(current.finding_merges), merge] };
    } else current = candidate;
  }
  for (const update of updates) {
    const candidate = { ...current, finding_updates: [...list(current.finding_updates), update] };
    if (hasOperations(current) && encodedSize(candidate) > limit) {
      flush();
      current = { ...current, finding_updates: [...list(current.finding_updates), update] };
    } else current = candidate;
  }
  flush();
  if (!chunks.length) return [input];
  // The final part also carries completion. A completion is always final; the
  // schema rejects `more` together with `complete`.
  if (input.complete) chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], complete: input.complete };
  return chunks.map((part, index) => {
    const last = index === chunks.length - 1;
    const more = last ? input.more === true && !input.complete : true;
    return { ...part, more };
  });
}
