import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { Graph, Step, decideSchema } from "../../protocol/src/index.js";
import { fail } from "./errors.js";
import { planNodeDeletions } from "./node-deletion.js";
import { planningRevision } from "../../protocol/src/planning.js";
import { DecisionContext, SettleConflict } from "./decisions-types.js";

export const now = () => new Date().toISOString();

/** Leads resolved by a Step carrying their id, or by an explicit disposition. */
export function leadDispositionConflicts(g: Graph, body: z.infer<typeof decideSchema>): SettleConflict[] {
  const conflicts: SettleConflict[] = [];
  const byId = new Map((g.leads ?? []).map((lead) => [lead.id, lead]));
  const seen = new Set<string>();
  for (const step of g.steps) {
    if (step.deleted || step.discarded) continue;
    for (const leadId of step.lead_ids ?? []) {
      const lead = byId.get(leadId);
      // A historical Step may outlive a later waiver; only an unknown id is invalid.
      if (!lead) conflicts.push({ kind: "lead", id: leadId, reason: `Unknown lead ${leadId} on Step ${step.id}` });
    }
  }
  for (const disposition of body.lead_dispositions) {
    const lead = byId.get(disposition.lead_id);
    if (!lead) {
      conflicts.push({ kind: "lead", id: disposition.lead_id, reason: "Lead not found" });
      continue;
    }
    if (lead.status === "waived") {
      conflicts.push({ kind: "lead", id: lead.id, reason: "Lead is already waived" });
      continue;
    }
    if (seen.has(lead.id)) {
      conflicts.push({ kind: "lead", id: lead.id, reason: "Lead has more than one disposition in this batch" });
      continue;
    }
    seen.add(lead.id);
    if (disposition.step_id) {
      const target = g.steps.find((step) => step.id === disposition.step_id && !step.deleted);
      if (!target)
        conflicts.push({ kind: "lead", id: lead.id, reason: `Unknown or deleted Step ${disposition.step_id}` });
      else if (target.discarded)
        conflicts.push({
          kind: "lead",
          id: lead.id,
          reason: `Step ${target.id} is already discarded; it cannot answer the lead`,
        });
    }
    if (!disposition.step_id && !disposition.waiver_reason?.trim())
      conflicts.push({ kind: "lead", id: lead.id, reason: "Lead disposition needs a Step or a waiver reason" });
  }
  return conflicts;
}

export function applyLeadDispositions(g: Graph, body: z.infer<typeof decideSchema>) {
  for (const lead of g.leads ?? []) {
    if (lead.status === "waived") continue;
    const disposition = body.lead_dispositions.find((d) => d.lead_id === lead.id);
    const carryingStep = g.steps.find(
      (candidate) => !candidate.deleted && !candidate.discarded && candidate.lead_ids?.includes(lead.id),
    );
    if (disposition?.waiver_reason?.trim()) {
      lead.status = "waived";
      lead.waiver_reason = disposition.waiver_reason;
      lead.converted_step_id = undefined;
    } else {
      const stepId = disposition?.step_id ?? carryingStep?.id;
      if (!stepId) continue;
      // Without an explicit disposition this is just reconciliation; do not
      // rewrite timestamps on every later settlement.
      if (!disposition && lead.status === "converted" && lead.converted_step_id === stepId) continue;
      lead.status = "converted";
      lead.converted_step_id = stepId;
    }
    lead.disposition_at = now();
    lead.disposition_by = body.worker;
  }
}

export function observedPlanning(g: Graph, body: { observation_revision: number; planning_revision?: number }) {
  return body.planning_revision ?? Math.min(body.observation_revision, planningRevision(g));
}

export function checkDecisionSnapshot(
  g: Graph,
  body: { revision: number; observation_revision: number; planning_revision?: number },
) {
  if (
    body.revision > g.revision ||
    body.observation_revision > g.observation_revision ||
    body.observation_revision > body.revision
  )
    fail(409, "Future snapshot");
  if (
    body.planning_revision !== undefined &&
    (body.planning_revision > planningRevision(g) || body.planning_revision > body.revision)
  )
    fail(409, "Future planning snapshot");
}

export function deletionSnapshotChanged(
  ctx: DecisionContext,
  g: Graph,
  body: { revision: number; observation_revision: number },
) {
  // Usage and heartbeats may advance the storage revision while Decide
  // is reading. Only unseen business changes can invalidate a deletion; the
  // same batch's independently committed plan is checked for dependencies below.
  return (
    body.observation_revision !== g.observation_revision ||
    !!ctx.db
      .prepare(
        `SELECT 1 FROM platform_event_history WHERE project_id=? AND revision>? AND revision<=? AND kind!='decide.planned'
      AND (json_extract(data,'$.semantic')=1 OR
        COALESCE(json_array_length(data,'$.changes.facts'),0) + COALESCE(json_array_length(data,'$.changes.steps'),0) +
        COALESCE(json_array_length(data,'$.changes.findings'),0) + COALESCE(json_array_length(data,'$.changes.goals'),0) +
        COALESCE(json_array_length(data,'$.changes.hints'),0) + COALESCE(json_array_length(data,'$.changes.assets'),0) +
        COALESCE(json_array_length(data,'$.changes.leads'),0) > 0) LIMIT 1`,
      )
      .get(g.project.id, body.revision, g.revision)
  );
}

export function checkHintSnapshot(
  db: DatabaseSync,
  g: Graph,
  body: Pick<z.infer<typeof decideSchema>, "observation_revision" | "steps" | "hint_notes">,
) {
  if (body.observation_revision === g.observation_revision) return;
  const referenced = new Set([
    ...body.steps.flatMap((step) => step.hint_ids ?? []),
    ...body.hint_notes.map((note) => note.id),
  ]);
  if (!referenced.size) return;
  const changes = db
    .prepare(
      `SELECT h.value FROM platform_event_history e, json_each(e.data, '$.changes.hints') h
      WHERE e.project_id=? AND e.revision>? AND json_extract(e.data, '$.semantic')=1`,
    )
    .iterate(g.project.id, body.observation_revision);
  for (const row of changes)
    if (referenced.has(JSON.parse(String(row.value)).id))
      fail(409, "Graph changed; refresh state before planning from Hints");
}

export function deletionMutationConflicts(
  g: Graph,
  body: z.infer<typeof decideSchema>,
  deletion: ReturnType<typeof planNodeDeletions>,
) {
  const mutated = [
    ...body.updates,
    ...body.closes,
    ...body.reopens,
    ...body.goals.filter((v) => v.id),
    ...body.finding_updates,
  ]
    .map((v) => v.id)
    .concat(body.finding_merges.flatMap((v) => [v.target_id, ...v.source_ids]));
  return mutated
    .filter((id): id is string => !!id && deletion.ids.has(id))
    .map((id) => ({
      kind: "delete" as const,
      id,
      reason: "A deleted node cannot also be updated, closed, reopened or merged in this settlement",
    }));
}

export function checkDeletedPlanDependencies(
  body: z.infer<typeof decideSchema>,
  deletion: ReturnType<typeof planNodeDeletions>,
) {
  for (const step of body.steps)
    if (step.from.some((id) => deletion.ids.has(id)) || (step.goal_id && deletion.ids.has(step.goal_id)))
      fail(422, "New plan depends on a node selected for deletion");
}
