import type { Graph } from "../../protocol/src/index.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fields = (records: object[], keys: string[]) =>
  records.map((record) => keys.map((key) => (record as Record<string, unknown>)[key] ?? null));

/** Actual business changes drive planning; bookkeeping and ordinary pass only affect delivery. */
export function planningChanged(before: Graph, after: Graph, kind: string): boolean {
  if (!kind || kind === "decide.planned") return false;
  if (
    !same(
      fields(before.facts, [
        "id",
        "description",
        "conclusion",
        "status",
        "objects",
        "evidence_ids",
        "asset_id",
        "deleted",
      ]),
      fields(after.facts, [
        "id",
        "description",
        "conclusion",
        "status",
        "objects",
        "evidence_ids",
        "asset_id",
        "deleted",
      ]),
    )
  )
    return true;
  if (
    !same(
      fields(before.steps, [
        "id",
        "from",
        "to",
        "asset_id",
        "description",
        "property",
        "priority",
        "discarded",
        "concluded_at",
        "executed_at",
        "summary",
        "blocked_run_id",
        "version",
        "goal_id",
        "hint_ids",
        "hint_versions",
        "lead_ids",
        "deleted",
      ]),
      fields(after.steps, [
        "id",
        "from",
        "to",
        "asset_id",
        "description",
        "property",
        "priority",
        "discarded",
        "concluded_at",
        "executed_at",
        "summary",
        "blocked_run_id",
        "version",
        "goal_id",
        "hint_ids",
        "hint_versions",
        "lead_ids",
        "deleted",
      ]),
    )
  )
    return true;
  // A newly discovered lead is planning input. Its later disposition (converted
  // or waived) is settlement bookkeeping, not a new planning change.
  if (
    !same(
      fields(before.leads ?? [], ["id", "surface", "parameter", "why", "suggested_property", "evidence_ids"]),
      fields(after.leads ?? [], ["id", "surface", "parameter", "why", "suggested_property", "evidence_ids"]),
    )
  )
    return true;
  if (
    !same(
      fields(before.goals, ["id", "description", "state", "deleted"]),
      fields(after.goals, ["id", "description", "state", "deleted"]),
    )
  )
    return true;
  if (
    !same(
      fields(before.hints, ["id", "content", "priority", "version", "withdrawn_at"]),
      fields(after.hints, ["id", "content", "priority", "version", "withdrawn_at"]),
    )
  )
    return true;
  // Operator confirmation closes a directive without asking for more planning.
  // Reopening is the opposite: the human says the work is still needed, so any
  // completion proposal from the previous wording must be discarded and Decide
  // must get a chance to plan it again.
  const previousHints = new Map(before.hints.map((hint) => [hint.id, hint]));
  if (
    after.hints.some((hint) => {
      const previous = previousHints.get(hint.id);
      return !!previous?.resolved && !hint.resolved && !hint.withdrawn_at;
    })
  )
    return true;
  if (
    !same(
      fields(before.assets, ["id", "hostname", "approval", "seed"]),
      fields(after.assets, ["id", "hostname", "approval", "seed"]),
    )
  )
    return true;
  const addedReviews = after.reviews.filter((r) => !before.reviews.some((old) => old.id === r.id));
  if (
    addedReviews.some(
      (r) => r.verdict !== "pass" || (r.planning_issues?.length ?? 0) > 0 || r.disputed_fact_ids.length > 0,
    )
  )
    return true;
  // Removing an operator waiver reopens that Review question, so Decide must see
  // it again. Adding a waiver only relaxes the completion gate.
  const previousReviews = new Map(before.reviews.map((review) => [review.id, review]));
  if (
    after.reviews.some((review) => {
      const previous = previousReviews.get(review.id);
      return (previous?.issue_waivers ?? []).some(
        (waiver) => !review.issue_waivers?.some((current) => current.index === waiver.index),
      );
    })
  )
    return true;
  // A normal Review may attach already archived supporting evidence and classify/rate
  // this version. It cannot edit the claim; those edits use the revision contract.
  const reviewed = new Set(addedReviews.filter((r) => r.verdict === "pass").map((r) => r.finding_id));
  const claim = (g: Graph) =>
    g.findings.map(
      (f) =>
        fields(
          [f],
          [
            "id",
            "version",
            "title",
            "description",
            "evidence",
            "from",
            "impact",
            "reproduction",
            "remediation",
            "identity",
            "asset_id",
            "merged_into",
            "withdrawn_at",
            "deleted",
            ...(!reviewed.has(f.id) ? ["evidence_ids", "kind"] : []),
          ],
        )[0],
    );
  if (!same(claim(before), claim(after))) return true;
  return (
    (before.project.status !== "active" && after.project.status === "active" && !after.project.reaudit) ||
    (after.project.last_error !== before.project.last_error &&
      kind === "job.failed" &&
      (after.project.job_failures?.execute ?? 0) > (before.project.job_failures?.execute ?? 0))
  );
}
