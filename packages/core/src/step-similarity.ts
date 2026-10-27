import type { Step } from "../../protocol/src/index.js";

/**
 * Input shape shared by `Store.insertStep` and the Decide planning path. Keeping
 * it structural means the similarity check never depends on Zod defaults.
 */
export type StepDraft = Pick<Step, "from" | "description"> &
  Partial<Pick<Step, "property" | "method_hint" | "test_domain" | "focus" | "asset_id" | "goal_id" | "priority">>;

/** Normalized character bigrams are enough here: the texts are Chinese/English task prose. */
export function normalizeStepText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index + 1 < text.length; index++) set.add(text.slice(index, index + 2));
  return set;
}

/**
 * Fraction of the shorter text's bigrams that also occur in the longer text.
 * Containment (not Dice) is the right measure for a refinement: the new Step is
 * often the old description with a target/endpoint added.
 */
export function stepTextContainment(a: string | undefined, b: string | undefined, minChars = 20): number {
  const left = normalizeStepText(a);
  const right = normalizeStepText(b);
  if (Math.min(left.length, right.length) < minChars) return 0;
  const first = bigrams(left);
  const second = bigrams(right);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared++;
  return shared / Math.min(first.size, second.size);
}

function sameFocus(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * A Step is sourced from the same origin or shares at least one Fact. `origin`
 * is included because the first plan is built before any Fact exists; a later
 * plan that re-grounds it in a Fact is still the same task.
 */
function sourcesRelated(a: string[], b: string[]): boolean {
  if (a.includes("origin") || b.includes("origin")) return true;
  const right = new Set(b);
  return a.some((id) => right.has(id));
}

const DESCRIPTION_CONTAINMENT = 0.78;
const PROPERTY_CONTAINMENT = 0.65;
const DESCRIPTION_WITHOUT_PROPERTY = 0.9;

/**
 * True when `input` is a paraphrase/refinement of an already-open, unstarted
 * Step. The bar is deliberately high:
 *   - same graph, test domain, asset and goal;
 *   - shared source Fact (or either side is the first `origin` plan);
 *   - a large part of the shorter description is contained in the other;
 *   - when both have a property, that property is also largely contained.
 *
 * Executed/running Steps are never merged: their wording is the question the
 * executor actually answered, so a new question must get a new Step.
 */
export function isNearDuplicateStep(existing: Step, input: StepDraft, graphId: string): boolean {
  if (existing.deleted || existing.concluded_at || existing.discarded) return false;
  if (existing.graph_id !== graphId) return false;
  // A running/executed Step already acted on its text; only a fresh Step may carry new wording.
  if (existing.worker || existing.executed_at) return false;
  // A blocked Step is waiting for a human inspection of the question that failed;
  // silently changing it would invalidate that inspection.
  if (existing.blocked_run_id) return false;
  if ((existing.test_domain ?? null) !== (input.test_domain ?? null)) return false;
  if (existing.asset_id !== input.asset_id || existing.goal_id !== input.goal_id) return false;
  if (!sourcesRelated(existing.from, input.from)) return false;
  const description = stepTextContainment(existing.description, input.description, 20);
  if (description < DESCRIPTION_CONTAINMENT) return false;
  const oldProperty = (existing.property ?? "").trim();
  const newProperty = (input.property ?? "").trim();
  if (oldProperty && newProperty) return stepTextContainment(oldProperty, newProperty, 12) >= PROPERTY_CONTAINMENT;
  // If one side is missing its falsifiable property, require near-verbatim prose
  // and the same focus label before calling the tasks identical.
  return description >= DESCRIPTION_WITHOUT_PROPERTY && sameFocus(existing.focus, input.focus);
}
