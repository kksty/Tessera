import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Graph, Step, Run, decideSchema, submitDecisionsSchema } from "../../protocol/src/index.js";
import { stepAssets } from "../../protocol/src/asset-scope.js";
import { validateCoverage } from "../../protocol/src/coverage.js";
import { digest } from "./execution.js";
import { fail } from "./errors.js";
import { reopenLeadsForStep } from "./leads.js";
import {
  applyFindingMerges,
  applyFindingUpdates,
  duplicateFindingGroups,
  findingMergeConflicts,
  findingUpdateConflicts,
} from "./finding-merges.js";
import { planNodeDeletions, applyNodeDeletions, previewNodeDeletions } from "./node-deletion.js";
import { isActiveNode } from "../../protocol/src/node-lifecycle.js";
import { planningRevision } from "../../protocol/src/planning.js";
import { reviewIssueConflicts } from "./review-issues.js";
import { acceptInformational, informationalAwaitingReview } from "./informational-review.js";

type StepInput = Pick<Step, "from" | "description"> &
  Partial<
    Pick<
      Step,
      | "priority"
      | "asset_id"
      | "goal_id"
      | "hint_ids"
      | "lead_ids"
      | "property"
      | "method_hint"
      | "test_domain"
      | "focus"
    >
  >;
export interface DecisionContext {
  db: DatabaseSync;
  mutate<T>(id: string, kind: string, observation: boolean, fn: (graph: Graph) => T): T;
  active(graph: Graph): void;
  validateSubmission(id: string, runId: string, body: { worker?: string }, kind: "decide"): unknown;
  insertStep(graph: Graph, input: StepInput, creator: string, graphId?: string): Step;
  checkStepVersion(step: Step, expected?: number): void;
  applyAssetStates(graph: Graph, states: z.infer<typeof decideSchema>["assets"]): void;
  endRun(graph: Graph, worker: string, status: Run["status"], error?: string, runId?: string): void;
  reopen(graph: Graph, step: Step, reason: string): void;
  /** 结束 Step 时给它的 blocked Run 结案；失败记录保留，不再计入待人工处理。 */
  settleBlockedRun(graph: Graph, step: Step, by: string): void;
  sources(graph: Graph, ids: string[]): void;
  sourceHint(graph: Graph, id: string): string;
  evidenceIds(graph: Graph, ids: string[]): void;
  next(items: { id: string }[], prefix: string): string;
  /** Operator review scope: informational findings are accepted without a Review run. */
  skipInformationalReview: boolean;
}
const now = () => new Date().toISOString();

/** Leads resolved by a Step carrying their id, or by an explicit disposition. */
function leadDispositionConflicts(g: Graph, body: z.infer<typeof decideSchema>): SettleConflict[] {
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

/** Open leads that no live Step, waiver or conversion in this batch resolves. */
function unresolvedLeads(g: Graph, body: z.infer<typeof decideSchema>, removed: Set<string> = new Set()) {
  const waived = new Set(body.lead_dispositions.filter((d) => d.waiver_reason?.trim()).map((d) => d.lead_id));
  // A disposition only answers the lead if its Step survives the batch. A Step
  // discarded or deleted in the same settlement cannot carry the next question,
  // otherwise completion could pass while the lead is reopened moments later.
  const attached = new Set(
    body.lead_dispositions
      .filter((d) => {
        if (!d.step_id || removed.has(d.step_id)) return false;
        const target = g.steps.find((step) => step.id === d.step_id);
        return !!target && !target.deleted && !target.discarded;
      })
      .map((d) => d.lead_id),
  );
  const live = new Set(
    g.steps.filter((step) => !step.deleted && !step.discarded && !removed.has(step.id)).map((step) => step.id),
  );
  for (const step of g.steps) if (live.has(step.id)) for (const leadId of step.lead_ids ?? []) attached.add(leadId);
  return (g.leads ?? []).filter((lead) => {
    if (lead.status === "waived") return false;
    if (waived.has(lead.id) || attached.has(lead.id)) return false;
    if (lead.status === "converted" && lead.converted_step_id && live.has(lead.converted_step_id)) return false;
    return lead.status === "open" || lead.status === "converted";
  });
}

function applyLeadDispositions(g: Graph, body: z.infer<typeof decideSchema>) {
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

export interface SettleConflict {
  kind:
    | "lease"
    | "snapshot"
    | "update"
    | "close"
    | "reopen"
    | "goal"
    | "asset"
    | "hint"
    | "lead"
    | "complete"
    | "finding_merge"
    | "finding_update"
    | "delete";
  id?: string;
  reason: string;
}
export interface DecisionPlanResult {
  plan_id: string;
  steps: string[];
  graph_id: string;
  revision: number;
  committed: boolean;
  reused: boolean;
}
export interface SettleResult {
  ok: boolean;
  conflicts: SettleConflict[];
  closed: string[];
  reopened: string[];
  updated: string[];
  completed: boolean;
  deleted: string[];
  affected: string[];
  cancelled_runs: string[];
  /** This part was accepted without ending the Decide lease (see `more`). */
  more?: boolean;
}
export interface DecisionResponse {
  plan_id: string;
  plan: DecisionPlanResult;
  settle: SettleResult;
}

function observedPlanning(g: Graph, body: { observation_revision: number; planning_revision?: number }) {
  return body.planning_revision ?? Math.min(body.observation_revision, planningRevision(g));
}
function checkDecisionSnapshot(
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

function deletionSnapshotChanged(
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

function checkHintSnapshot(
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

function deletionMutationConflicts(
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
function checkDeletedPlanDependencies(
  body: z.infer<typeof decideSchema>,
  deletion: ReturnType<typeof planNodeDeletions>,
) {
  for (const step of body.steps)
    if (step.from.some((id) => deletion.ids.has(id)) || (step.goal_id && deletion.ids.has(step.goal_id)))
      fail(422, "New plan depends on a node selected for deletion");
}

export function submitDecisionBatch(
  ctx: DecisionContext,
  id: string,
  body: z.infer<typeof submitDecisionsSchema>,
  runId?: string,
): DecisionResponse {
  const requestHash = digest({
    worker: body.worker,
    revision: body.revision,
    observation_revision: body.observation_revision,
    ...(body.planning_revision !== undefined ? { planning_revision: body.planning_revision } : {}),
    graph_id: body.graph_id,
    plan_id: body.plan_id ?? null,
    steps: body.steps,
    updates: body.updates,
    closes: body.closes,
    reopens: body.reopens,
    goals: body.goals,
    assets: body.assets,
    hint_notes: body.hint_notes,
    complete: body.complete ?? null,
    lead_dispositions: body.lead_dispositions,
    ...(body.finding_merges.length ? { finding_merges: body.finding_merges } : {}),
    ...(body.finding_updates.length ? { finding_updates: body.finding_updates } : {}),
    ...(body.delete_nodes.length ? { delete_nodes: body.delete_nodes } : {}),
    ...(body.deletion_preview_hash ? { deletion_preview_hash: body.deletion_preview_hash } : {}),
  });
  const saved = ctx.db
    .prepare("SELECT request_hash,response FROM platform_submissions WHERE project_id=? AND submission_id=?")
    .get(id, body.submission_id);
  if (saved) {
    if (String(saved.request_hash) !== requestHash) fail(409, "Submission id already used with different content");
    return JSON.parse(String(saved.response)) as DecisionResponse;
  }
  // Accepted writes remain replayable after settlement ends the Run or project.
  // Only a new submission needs a current lease.
  if (runId) ctx.validateSubmission(id, runId, body, "decide");
  const plan = ctx.mutate(id, "decide.planned", false, (g) => {
    ctx.active(g);
    if (g.project.reason?.worker !== body.worker) fail(409, "Decide lease required");
    if (body.graph_id !== "main") fail(422, "Unknown graph");
    checkDecisionSnapshot(g, body);
    checkHintSnapshot(ctx.db, g, body);
    const deletion = planNodeDeletions(g, body.delete_nodes);
    checkDeletedPlanDependencies(body, deletion);
    // The same submission (a retried request whose response was lost) reuses its plan.
    const recorded = ctx.db
      .prepare("SELECT plan_id,data FROM platform_plans WHERE project_id=? AND submission_id=?")
      .get(id, body.submission_id);
    if (recorded) {
      const data = JSON.parse(String(recorded.data));
      if (data.request_hash && data.request_hash !== requestHash)
        fail(409, "Submission id already used with different content");
      return {
        ...(data as Omit<DecisionPlanResult, "plan_id" | "committed" | "reused">),
        plan_id: String(recorded.plan_id),
        committed: true,
        reused: true,
      };
    }
    if (body.plan_id) {
      const row = ctx.db
        .prepare("SELECT data FROM platform_plans WHERE plan_id=? AND project_id=?")
        .get(body.plan_id, id);
      if (!row) fail(404, "Unknown plan_id");
      const savedPlan = JSON.parse(String(row!.data)) as { steps: string[]; graph_id: string; revision: number };
      return { ...savedPlan, plan_id: body.plan_id, committed: true, reused: true };
    }
    const targetGraph = body.graph_id;
    // Plan only appends Steps. Asset cooling/warming is a settlement mutation:
    // a settle conflict must not leave the graph half-changed.
    const requestedIds = new Set(body.delete_nodes.map((node) => node.id));
    const steps = body.steps.map((s) => {
      const step = ctx.insertStep(g, s, body.worker, targetGraph);
      if (deletion.ids.has(step.id) || requestedIds.has(step.id))
        fail(422, "New plan conflicts with a node selected for deletion");
      return step.id;
    });
    const plan: DecisionPlanResult = {
      plan_id: `plan_${randomUUID()}`,
      steps,
      graph_id: targetGraph,
      revision: g.revision + 1,
      committed: true,
      reused: false,
    };
    ctx.db
      .prepare("INSERT INTO platform_plans(plan_id,project_id,submission_id,data,created_at) VALUES(?,?,?,?,?)")
      .run(
        plan.plan_id,
        id,
        body.submission_id,
        JSON.stringify({
          steps: plan.steps,
          graph_id: plan.graph_id,
          revision: plan.revision,
          request_hash: requestHash,
        }),
        now(),
      );
    return plan;
  });
  const settle = ctx.mutate(id, "decide.committed", false, (g) => {
    ctx.active(g);
    const result: SettleResult = {
      ok: false,
      conflicts: [],
      closed: [],
      reopened: [],
      updated: [],
      completed: false,
      deleted: [],
      affected: [],
      cancelled_runs: [],
    };
    const save = (response: DecisionResponse) => {
      ctx.db
        .prepare(
          "INSERT OR REPLACE INTO platform_submissions(project_id,submission_id,request_hash,response,plan_id,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(id, body.submission_id, requestHash, JSON.stringify(response), response.plan_id, now());
      return response.settle;
    };
    if (g.project.reason?.worker !== body.worker) {
      result.conflicts.push({ kind: "lease", reason: "Decide lease required" });
      return save({ plan_id: plan.plan_id, plan, settle: result });
    }
    if (body.more && body.complete) {
      result.conflicts.push({
        kind: "complete",
        reason: "A completion ends the Decide run; send it as the final part without more",
      });
      return save({ plan_id: plan.plan_id, plan, settle: result });
    }
    const runId = g.project.reason?.run_id;
    const deletion = planNodeDeletions(g, body.delete_nodes);
    result.conflicts.push(...deletion.conflicts, ...deletionMutationConflicts(g, body, deletion));
    if (
      body.deletion_preview_hash &&
      body.deletion_preview_hash !== previewNodeDeletions(g, body.delete_nodes, deletion).impact_hash
    )
      result.conflicts.push({
        kind: "delete",
        reason: "Deletion impact changed; call preview_deletions again before submitting",
      });
    if (body.delete_nodes.length && deletionSnapshotChanged(ctx, g, body))
      result.conflicts.push({ kind: "snapshot", reason: "Graph changed; refresh before deleting nodes" });
    for (const update of body.finding_updates)
      if (update.changes.from?.some((id) => deletion.ids.has(id)))
        result.conflicts.push({
          kind: "delete",
          id: update.id,
          reason: "Finding update depends on a node selected for deletion",
        });
    result.conflicts.push(...findingMergeConflicts(g, body.finding_merges));
    result.conflicts.push(...findingUpdateConflicts(g, body.finding_updates));
    result.conflicts.push(...leadDispositionConflicts(g, body));
    if (body.revision > g.revision) {
      result.conflicts.push({ kind: "snapshot", reason: "Future snapshot" });
      return save({ plan_id: plan.plan_id, plan, settle: result });
    }
    const versionOf = (step: Step) => step.version ?? 1;
    const checkVersion = (kind: SettleConflict["kind"], step: Step, expected: number | undefined) => {
      if (expected === undefined) {
        result.conflicts.push({
          kind,
          id: step.id,
          reason: "expected_version is required; read the current v from the entry",
        });
        return false;
      }
      if (versionOf(step) !== expected) {
        result.conflicts.push({
          kind,
          id: step.id,
          reason: `version changed (expected ${expected}, current ${versionOf(step)})`,
        });
        return false;
      }
      return true;
    };
    const updates: { input: (typeof body.updates)[number]; step: Step }[] = [];
    for (const input of body.updates) {
      const step = g.steps.find((s) => s.id === input.id);
      if (!step || step.deleted) {
        result.conflicts.push({ kind: "update", id: input.id, reason: "Step not found or deleted" });
        continue;
      }
      if (!checkVersion("update", step, input.expected_version)) continue;
      if (input.discard && step.concluded_at) {
        result.conflicts.push({ kind: "update", id: input.id, reason: "Step is already concluded" });
        continue;
      }
      updates.push({ input, step });
    }
    const closes: { input: (typeof body.closes)[number]; step: Step }[] = [];
    for (const input of body.closes) {
      const step = g.steps.find((s) => s.id === input.id);
      if (!step || step.deleted) {
        result.conflicts.push({ kind: "close", id: input.id, reason: "Step not found or deleted" });
        continue;
      }
      if (step.concluded_at || step.discarded) {
        result.conflicts.push({ kind: "close", id: input.id, reason: "Step is already concluded" });
        continue;
      }
      if (!checkVersion("close", step, input.expected_version)) continue;
      const missing = input.evidence_ids.filter((eid) => !g.evidence.some((e) => e.id === eid));
      if (missing.length) {
        result.conflicts.push({ kind: "close", id: input.id, reason: `Unknown evidence ${missing.join(", ")}` });
        continue;
      }
      closes.push({ input, step });
    }
    const reopens: { input: (typeof body.reopens)[number]; step: Step }[] = [];
    for (const input of body.reopens) {
      const step = g.steps.find((s) => s.id === input.id);
      if (!step || step.deleted) {
        result.conflicts.push({ kind: "reopen", id: input.id, reason: "Step not found or deleted" });
        continue;
      }
      if (!step.concluded_at) {
        result.conflicts.push({ kind: "reopen", id: input.id, reason: "Only a concluded step can be reopened" });
        continue;
      }
      if (!checkVersion("reopen", step, input.expected_version)) continue;
      const missing = step.from.filter((fid) => fid === "goal" || !g.facts.some((f) => f.id === fid));
      if (missing.length) {
        result.conflicts.push({
          kind: "reopen",
          id: input.id,
          reason: `Source fact no longer exists: ${missing.join(", ")}`,
        });
        continue;
      }
      const unapproved = stepAssets(g, step).filter(
        (aid) => !g.assets.some((a) => a.id === aid && a.approval === "approved"),
      );
      if (unapproved.length) {
        result.conflicts.push({
          kind: "reopen",
          id: input.id,
          reason: `Asset is no longer approved: ${unapproved.join(", ")}`,
        });
        continue;
      }
      reopens.push({ input, step });
    }
    for (const input of body.goals) {
      if (input.id === "goal") {
        result.conflicts.push({ kind: "goal", reason: "Use complete for the root goal" });
        continue;
      }
      if (input.id && !g.goals.some((v) => v.id === input.id && !v.deleted))
        result.conflicts.push({ kind: "goal", id: input.id, reason: "Goal not found" });
    }
    for (const input of body.assets)
      if (!g.assets.some((a) => a.id === input.id))
        result.conflicts.push({ kind: "asset", id: input.id, reason: "Asset not found" });
    const hinted: { id: string; note: string }[] = [];
    for (const note of body.hint_notes) {
      const hint = g.hints.find((h) => h.id === note.id && !h.withdrawn_at);
      if (!hint) {
        result.conflicts.push({ kind: "hint", id: note.id, reason: "Hint not found or withdrawn" });
        continue;
      }
      hinted.push({ id: hint.id, note: note.note });
    }
    if (body.complete) {
      const retired = new Set([...body.finding_merges.flatMap((m) => m.source_ids), ...deletion.ids]);
      const projected = g.findings
        .filter((f) => !retired.has(f.id))
        .map((f) => {
          const update = body.finding_updates.find((u) => u.id === f.id);
          return { ...f, ...update?.changes, ...(update?.withdraw ? { status: "rejected" as const } : {}) };
        });
      if (duplicateFindingGroups(projected).length)
        result.conflicts.push({
          kind: "complete",
          reason: "Merge duplicate findings or correct their identities before completing",
        });
      const missing = body.complete.from.filter(
        (fid) => fid === "goal" || deletion.ids.has(fid) || !g.facts.some((f) => f.id === fid && !f.deleted),
      );
      const closingIds = new Set(closes.map(({ step }) => step.id));
      const discardedIds = new Set(updates.filter(({ input }) => input.discard).map(({ step }) => step.id));
      const reopenedIds = new Set(reopens.map(({ step }) => step.id));
      // Evaluate the board as it will look after this settlement, not before it.
      // A Step that is still running is unfinished work: only this settlement's
      // close/discard may retire it, otherwise completion would be a promise the
      // next observation silently breaks.
      const remaining = g.steps.filter((step) => {
        if (step.deleted || deletion.ids.has(step.id)) return false;
        const reopened = reopenedIds.has(step.id);
        const concluded = reopened ? false : !!step.concluded_at || closingIds.has(step.id);
        const discarded = reopened ? false : step.discarded || discardedIds.has(step.id);
        return !concluded && !discarded;
      });
      if (missing.length)
        result.conflicts.push({
          kind: "complete",
          // Reuse the same per-id explanation as write-time validation so a
          // Finding ID gets the "use finding_updates" hint instead of a bare
          // invalid-Fact message.
          reason: `Invalid source fact ${missing
            .map((fid) =>
              deletion.ids.has(fid)
                ? `${fid}（该节点在同批删除中，不能作为完成依据）`
                : `${fid}${ctx.sourceHint(g, fid)}`,
            )
            .join(", ")}`,
        });
      else if (remaining.length)
        result.conflicts.push({ kind: "complete", reason: "Conclude or discard remaining steps before completing" });
      else if (observedPlanning(g, body) !== planningRevision(g))
        result.conflicts.push({ kind: "complete", reason: "Graph changed; refresh planning state before completing" });
      else {
        // A Hint is a human directive. A model note is advice only; only the
        // operator can close it, so completion waits for that confirmation even
        // when a Step already carried the wording.
        const openHints = g.hints.filter((h) => !h.withdrawn_at && !h.resolved);
        if (openHints.length)
          result.conflicts.push({
            kind: "complete",
            reason:
              `Hint 需人工确认后才能完成项目：${openHints.map((h) => h.id).join(", ")}；` +
              "hint_notes 只记录建议，不关闭 Hint。请在提示面板确认或撤回后再完成",
          });
      }
      // Coverage is checked independently of the Hint gate so one submission
      // names both the open directive and every surface that is still missing.
      const coverage = validateCoverage(g, body.complete.coverage ?? []);
      for (const problem of coverage.invalid.slice(0, 5))
        result.conflicts.push({ kind: "complete", reason: `Coverage invalid: ${problem}` });
      if (coverage.invalid.length > 5)
        result.conflicts.push({ kind: "complete", reason: `Coverage invalid: 另有 ${coverage.invalid.length - 5} 项` });
      if (coverage.missing.length) {
        const shown = coverage.missing.slice(0, 12);
        result.conflicts.push({
          kind: "complete",
          reason:
            `Coverage 未覆盖 ${coverage.missing.length} 个已观测 surface：${shown.join(", ")}` +
            `${coverage.missing.length > shown.length ? ` 等（共 ${coverage.missing.length} 项）` : ""}；` +
            "complete.coverage 逐项标记 tested（带 evidence_ids）、waived（带 reason）或 na",
        });
      }
      const openLeads = unresolvedLeads(g, body, new Set([...deletion.ids, ...discardedIds]));
      if (openLeads.length)
        result.conflicts.push({
          kind: "complete",
          reason:
            `Open leads 阻止完成：${openLeads
              .slice(0, 12)
              .map((lead) => lead.id)
              .join(", ")}` +
            `${openLeads.length > 12 ? ` 等（共 ${openLeads.length} 项）` : ""}；` +
            "用新 Step 的 lead_ids 落实，或用 lead_dispositions 的 waiver_reason 说明不追究",
        });
      // A Review planning issue is a queued question, not a note. Completion must
      // either name follow-up work executed after that Review or explain why the
      // question is dismissed; high-risk dismissals need an operator waiver.
      // Only a removed finding (deleted, merged as a source, or withdrawn) stops
      // holding the gate. A content revision creates a new version and a fresh
      // Review, so it cannot be used to erase the current version's issues while
      // completing in the same batch.
      const retiredFindings = new Set([
        ...body.finding_merges.flatMap((merge) => merge.source_ids),
        ...body.finding_updates.filter((update) => update.withdraw).map((update) => update.id),
        ...deletion.ids,
      ]);
      result.conflicts.push(
        ...reviewIssueConflicts(g, body.complete.review_issues, {
          retired: retiredFindings,
          closingIds,
          reopenedIds,
        }).map((reason) => ({ kind: "complete" as const, reason })),
      );
    }
    // A settle conflict leaves every node untouched; the plan stays committed.
    if (result.conflicts.length) return save({ plan_id: plan.plan_id, plan, settle: result });
    ctx.applyAssetStates(g, body.assets);
    applyFindingMerges(g, body.finding_merges, body.worker, ctx.endRun);
    applyFindingUpdates(g, body.finding_updates, body.worker, ctx.endRun);
    // Revisions and merges produce a new version; an information class that
    // still cites evidence stays outside Review under the same policy.
    if (ctx.skipInformationalReview) {
      const touched = new Set([
        ...body.finding_updates.map((update) => update.id),
        ...body.finding_merges.flatMap((merge) => [merge.target_id, ...merge.source_ids]),
      ]);
      for (const finding of g.findings)
        if (touched.has(finding.id) && informationalAwaitingReview(finding)) acceptInformational(g, finding);
    }
    applyLeadDispositions(g, body);
    for (const { input, step } of updates) {
      if (input.priority !== undefined) {
        if (step.priority !== input.priority) step.version = versionOf(step) + 1;
        step.priority = input.priority;
      }
      // 测试域与 focus 只是分类标签：补齐旧 Step 时不改 version，也不触发重新规划。
      if (input.test_domain && step.test_domain !== input.test_domain) step.test_domain = input.test_domain;
      if (input.focus !== undefined) {
        const focus = input.focus.trim();
        if ((step.focus ?? "") !== focus) step.focus = focus || undefined;
      }
      if (input.discard && !step.concluded_at) {
        if (step.worker) ctx.endRun(g, step.worker, "cancelled", "Step discarded by Decide", step.run_id);
        ctx.settleBlockedRun(g, step, "step.discarded");
        step.discarded = true;
        step.concluded_at = now();
        step.worker = null;
        step.version = versionOf(step) + 1;
        if (input.reason) step.discard_reason = input.reason;
        // A discarded Step no longer answers its leads.
        reopenLeadsForStep(g, step.id);
      }
      result.updated.push(step.id);
    }
    for (const { input, step } of closes) {
      if (step.worker) ctx.endRun(g, step.worker, "cancelled", "Step closed by Decide", step.run_id);
      ctx.settleBlockedRun(g, step, "step.closed");
      step.concluded_at = now();
      step.close_reason = input.reason;
      step.worker = null;
      step.version = versionOf(step) + 1;
      result.closed.push(step.id);
    }
    for (const { input, step } of reopens) {
      ctx.reopen(g, step, input.reason);
      result.reopened.push(step.id);
    }
    for (const input of body.goals) {
      if (input.id)
        Object.assign(
          g.goals.find((v) => v.id === input.id)!,
          input,
        );
      else g.goals.push({ ...input, id: ctx.next(g.goals, "g"), graph_id: plan.graph_id });
    }
    for (const note of hinted) {
      const hint = g.hints.find((h) => h.id === note.id && !h.withdrawn_at);
      if (!hint) continue;
      // Advice, not closure: keep one bounded trail per Hint and leave the
      // operator-only `resolved` field untouched.
      hint.notes = [...(hint.notes ?? []), { at: now(), note: note.note, worker: body.worker }].slice(-10);
    }
    Object.assign(
      result,
      applyNodeDeletions(
        g,
        deletion,
        { by: body.worker, run_id: runId, submission_id: body.submission_id },
        ctx.endRun,
      ),
    );
    // Deleting a Step does not answer its Leads: put them back on the open list.
    for (const deletedId of result.deleted) reopenLeadsForStep(g, deletedId);
    if (!body.more) {
      g.project.pending_completion = undefined;
      if (body.complete) {
        ctx.sources(g, body.complete.from);
        g.project.pending_completion = {
          ...body.complete,
          worker: body.worker,
          graph_id: body.graph_id,
          observation_revision: body.observation_revision,
          planning_revision: observedPlanning(g, body),
        };
        result.completed = true;
      }
      g.decided_revision = body.observation_revision;
      g.decided_planning_revision = observedPlanning(g, body);
      if (planningRevision(g) === g.decided_planning_revision) g.project.decide_pending_since = undefined;
      g.project.decision_round = (g.project.decision_round ?? 0) + 1;
      g.project.reason = null;
      g.project.last_error = undefined;
      ctx.endRun(g, body.worker, "succeeded", undefined, runId);
    }
    result.ok = true;
    result.more = body.more;
    return save({ plan_id: plan.plan_id, plan, settle: result });
  });
  return { plan_id: plan.plan_id, plan, settle };
}
