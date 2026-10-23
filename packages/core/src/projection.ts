import type { Asset, Fact, Finding, Goal, Graph, Job, Lead, Step } from "../../protocol/src/index.js";
import type { ChangesPage } from "./memory-changes.js";
import { effectiveStepPriority, stepCoversHint } from "./hint-coverage.js";
import { coverageSurfaces } from "../../protocol/src/coverage.js";
import { duplicateFindingGroups, relatedFindingGroups, mergedFindingSources } from "./finding-merges.js";
import { resolveGraphRelations } from "../../protocol/src/graph-relations.js";
import { findingKind, classificationReviewRequired } from "../../protocol/src/finding-policy.js";
import { planningRevision, decidedPlanningRevision, searchState } from "../../protocol/src/planning.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { reviewIssueRisk, reviewIssueWaiver } from "../../protocol/src/review-issues.js";
import { openReviewIssues } from "./review-issues.js";

/**
 * Projections are computed on read, never cached. Three thicknesses share the same
 * renderer: the decision entry (full summary), the cold search result (thicker) and
 * the frontend (complete record). Only the body is cut; `conclusion` never is.
 */
export const SUMMARY_BODY_LIMIT = 300;
export const COLD_BODY_LIMIT = 600;
export const OPEN_STEP_PREVIEW_LIMIT = 200;
/** Execute carries the current Step's direct claims; the retest target is never dropped. */
export const EXECUTE_CLAIM_BUDGET = 8000;
const EXECUTE_LAST_SUMMARY_LIMIT = 1000;
const EXECUTE_SOURCE_STEP_LIMIT = 3;
const EXECUTE_SOURCE_TEXT_LIMIT = 600;
const REVIEW_SOURCE_FACT_LIMIT = 3;
const REVIEW_SOURCE_TEXT_LIMIT = 2000;

/** Sentence end: CJK punctuation, or ASCII punctuation followed by whitespace/end. */
const SENTENCE_END_GLOBAL = /[。！？!?；;\n]|[.!?](?=\s|$)/g;

/** First sentence within the limit, preferring a sentence boundary over a hard cut. */
export function firstSentence(text: string, limit = SUMMARY_BODY_LIMIT): string {
  const source = text.replace(/\s+/g, " ").trim();
  if (source.length <= limit) return source;
  const window = source.slice(0, limit);
  let boundary = -1;
  for (const match of window.matchAll(SENTENCE_END_GLOBAL)) boundary = Math.max(boundary, match.index ?? -1);
  if (boundary > 0) return window.slice(0, boundary + 1).trim();
  return window.trimEnd() + "…";
}

/** A migration may infer a conclusion from the body; the projection marks it as inferred. */
export function conclusionFrom(description: string, limit = 120): string {
  const source = description.replace(/\s+/g, " ").trim();
  const window = source.slice(0, limit);
  SENTENCE_END_GLOBAL.lastIndex = 0;
  for (const match of window.matchAll(SENTENCE_END_GLOBAL)) {
    const end = match.index ?? -1;
    if (end >= 0) return window.slice(0, end + 1).trim();
  }
  return window.trim();
}

function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  const source = text.trim();
  return source.length > limit
    ? { text: `${source.slice(0, limit)}…`, truncated: true }
    : { text: source, truncated: false };
}

/** Retest target first, then the Finding this Step revises or produced, then other direct claims. */
function claimRank(finding: Finding, step: Step | null): number {
  if (!step) return 9;
  if (finding.id === step.retest_finding_id) return 0;
  if (finding.revision_step_id === step.id) return 1;
  if (finding.step_id === step.id) return 2;
  return 3;
}

/** A Finding is a claim, not Evidence: keep the report fields an executor cannot infer. */
function findingClaim(finding: Finding): { claim: Record<string, unknown>; characters: number } {
  const truncated: string[] = [];
  const take = (field: string, value: string | null | undefined, limit: number): string | null => {
    if (!value) return null;
    const clipped = bounded(value, limit);
    if (clipped.truncated) truncated.push(field);
    return clipped.text;
  };
  const list = (field: string, values: string[] | undefined, count: number, each: number): string[] => {
    if (!values?.length) return [];
    if (values.length > count) truncated.push(`${field}.count`);
    return values.slice(0, count).map((value, index) => {
      const clipped = bounded(value, each);
      if (clipped.truncated) truncated.push(`${field}[${index}]`);
      return clipped.text;
    });
  };
  const reproduction = finding.reproduction
    ? {
        conditions: list("reproduction.conditions", finding.reproduction.conditions, 5, 200),
        steps: list("reproduction.steps", finding.reproduction.steps, 6, 600),
        expected: take("reproduction.expected", finding.reproduction.expected, 400),
        observed: take("reproduction.observed", finding.reproduction.observed, 400),
      }
    : null;
  const claim = {
    claim: true,
    impact: take("impact", finding.impact, 1200),
    reproduction,
    remediation: take("remediation", finding.remediation, 1200),
    ...(truncated.length ? { truncated_fields: truncated } : {}),
  };
  return { claim, characters: JSON.stringify(claim).length };
}

export type StepState = "pending" | "running" | "blocked" | "executed" | "concluded" | "discarded";

export function stepState(step: Step): StepState {
  if (step.discarded) return "discarded";
  if (step.concluded_at) return "concluded";
  if (step.executed_at) return "executed";
  if (step.blocked_run_id) return "blocked";
  if (step.worker) return "running";
  return "pending";
}

/** The entry's "unclosed" count equals the scheduler's "not finished" set minus discarded. */
export const unclosedStep = (step: Step) => !step.deleted && !step.concluded_at && !step.discarded;

export function findingState(finding: Finding): string {
  if (finding.withdrawn_at) return "withdrawn";
  if (finding.merged_into) return `merged→${finding.merged_into}`;
  if (finding.review_status === "pending") return "pending";
  if (finding.status === "confirmed") return "confirmed";
  return finding.review_status;
}

export function factLine(fact: Fact): string {
  const objects = fact.objects?.length ? ` [${fact.objects.join(", ")}]` : "";
  const inferred = fact.conclusion_inferred || !fact.conclusion ? "（推断）" : "";
  const status = fact.status ?? "observed";
  const conclusion = fact.conclusion ?? conclusionFrom(fact.description);
  const body = firstSentence(fact.description);
  const request = fact.request ? ` 请求：${fact.request.method.toUpperCase()} ${fact.request.url}` : "";
  const sources = fact.parameter_sources?.length
    ? ` 参数来源：${fact.parameter_sources.map((s) => `${s.parameter}←${s.source}`).join("；")}`
    : status === "not_observed"
      ? " ⚠ 缺参数溯源"
      : "";
  return `${fact.id}${objects} ${status} ${inferred}${conclusion} — ${body}${request}${sources}`;
}

export function stepLine(step: Step, priority = step.priority): string {
  const objects = step.asset_id ? ` [${step.asset_id}]` : "";
  const from = step.from.length ? ` ← ${step.from.join(",")}` : "";
  const outputs = step.fact_ids.length ? ` → ${step.fact_ids.join(",")}` : "";
  const summary = step.summary ? ` 执行摘要：${firstSentence(step.summary)}` : "";
  const reason = step.close_reason ? ` 关闭理由：${firstSentence(step.close_reason, 120)}` : "";
  const reopen = step.reopen_reason ? ` 重开理由：${firstSentence(step.reopen_reason, 120)}` : "";
  const property = step.property ? ` 属性：${firstSentence(step.property, 200)}` : "";
  const method = step.method_hint ? ` 方法建议：${firstSentence(step.method_hint, 160)}` : "";
  return `${step.id}${objects} ${stepState(step)} p${priority} v${step.version ?? 1}${from}${outputs} — ${firstSentence(step.description)}${property}${method}${summary}${reason}${reopen}`;
}

export function findingLine(finding: Finding): string {
  const objects = finding.asset_id ? ` [${finding.asset_id}]` : "";
  const severity = finding.severity ? ` ${finding.severity}` : "";
  const cvss = finding.cvss ? ` cvss ${finding.cvss.score.toFixed(1)}` : "";
  return `${finding.id}${objects} v${finding.version} ${findingState(finding)} kind=${findingKind(finding) ?? "null"}${classificationReviewRequired(finding) ? " needs_classification_review" : ""}${severity}${cvss} — ${firstSentence(finding.title, 120)}：${firstSentence(finding.description)}`;
}

export function goalLine(goal: Goal): string {
  return `${goal.id} ${goal.state} — ${firstSentence(goal.description)}`;
}

/**
 * A Hint is a human directive, not background text: order by weight (bigger
 * first) and say on the line which Step carries it, or that it was explained
 * away. Long hints keep their full wording up to a bounded size so the tail
 * instruction (path, credential, prohibition) is not silently dropped.
 */
export function hintLine(hint: Graph["hints"][number], steps: Step[]): string {
  const covered = steps.filter((step) => stepCoversHint(step, hint)).map((step) => step.id);
  const advice = hint.notes?.at(-1);
  const status = hint.resolved
    ? `已人工确认：${firstSentence(hint.resolved.note, 120)}`
    : covered.length
      ? `→ ${covered.join(",")}（仍待人工确认）`
      : advice
        ? `待人工确认（Decide 建议：${firstSentence(advice.note, 120)}）`
        : "待人工确认";
  const content =
    hint.content.length > 1200 ? `${hint.content.slice(0, 1200)}…（read_graph ${hint.id} 读全文）` : hint.content;
  return `${hint.id} p${hint.priority ?? 0} ${status} — ${content}`;
}

export function leadLine(lead: Lead): string {
  const parameter = lead.parameter ? ` 参数=${lead.parameter}` : "";
  const step = lead.converted_step_id ? ` → ${lead.converted_step_id}` : "";
  return `${lead.id} ${lead.status}${step} ${lead.surface}${parameter} — ${firstSentence(lead.why, 200)}；建议属性：${firstSentence(lead.suggested_property, 200)}`;
}

export function assetLine(asset: Asset): string {
  return `${asset.id} ${asset.approval}${asset.seed ? " seed" : ""} — ${asset.hostname}`;
}

/** Default hot budget for entry-listed Facts/Findings. 0 disables cooling. */
export const HOT_LIMIT_DEFAULT = 200;

export type ColdKind = "facts" | "findings";
export interface ColdNode {
  kind: ColdKind;
  record: Record<string, any>;
}
export interface ColdView {
  disabled: boolean;
  limit: number;
  cold: Set<string>;
}

/**
 * Hot/cold is a working-set decision, not a time threshold: the entry keeps the
 * most recently used Facts/Findings up to `hot_limit`. Open work and pinned nodes
 * are always hot. Only Facts/Findings ever cool: closed Steps and Evidence are
 * not entry material and not cold nodes either, so they never consume the hot
 * budget or `cold.count`; `query_graph`/the evidence page still exposes them.
 *
 * Never-used nodes rank last. If they fall outside the budget they are still shown
 * in the cold preview as `未引用` and remain reachable by query/read; that is the
 * deliberate v1 trade-off for bounding the entry.
 */
export function coldView(graph: Graph): ColdView {
  graph = activeGraph(graph);
  const limit = Math.max(0, graph.project.hot_limit ?? HOT_LIMIT_DEFAULT);
  const cold = new Set<string>();
  if (!limit) return { disabled: true, limit: 0, cold };
  const openSteps = new Set((graph.steps ?? []).filter(unclosedStep).map((step) => step.id));
  const reviewFindings = graph.findings.filter((f) => {
    const latest = graph.reviews.filter((r) => r.finding_id === f.id && r.finding_version === f.version).at(-1);
    return (
      !f.merged_into &&
      !f.withdrawn_at &&
      (classificationReviewRequired(f, graph) ||
        (latest && (latest.verdict !== "pass" || !!latest.planning_issues?.length)))
    );
  });
  const directFacts = new Set([
    ...graph.steps.filter((step) => openSteps.has(step.id)).flatMap((step) => [...step.from, ...step.fact_ids]),
    ...reviewFindings.flatMap((f) => f.from),
  ]);
  const candidates: { id: string; last: number; created: string }[] = [];
  const consider = (record: Record<string, any>, last: number) => {
    if (record.cooldown_override === "pinned") return;
    if (record.cooldown_override === "cooled") {
      cold.add(String(record.id));
      return;
    }
    candidates.push({ id: String(record.id), last, created: String(record.created_at ?? "") });
  };
  for (const fact of graph.facts ?? []) {
    if (fact.id === "origin" || fact.kind === "navigation" || directFacts.has(fact.id)) continue;
    consider(fact, Math.max(fact.last_referenced_round ?? -1, fact.last_read_round ?? -1));
  }
  for (const finding of graph.findings ?? []) {
    // A Finding is the deliverable of its Step: while that Step is open, the Finding
    // is part of the open work and must not disappear from the entry with it.
    const stepId = finding.step_id ?? finding.revision_step_id;
    if ((stepId && openSteps.has(stepId)) || reviewFindings.some((f) => f.id === finding.id)) continue;
    consider(finding, Math.max(finding.last_referenced_round ?? -1, finding.last_read_round ?? -1));
  }
  // Closed Steps and Evidence are not cold nodes: they are history, not entry
  // material, and are reached through query_graph/evidence pages instead.
  // Most recently used first; creation order is the deterministic tiebreaker.
  candidates.sort((a, b) => b.last - a.last || a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  for (let index = limit; index < candidates.length; index++) cold.add(candidates[index].id);
  return { disabled: false, limit, cold };
}

/** Compatibility helper for single-node checks; prefer coldView() when checking many. */
export function isCold(graph: Graph, node: { id: string; cooldown_override?: string }, open = false): boolean {
  if (open) return false;
  return coldView(graph).cold.has(node.id);
}

/** The cold pool, defined once so the entry count, the preview and peek cannot drift apart. */
export function coldNodes(graph: Graph): ColdNode[] {
  graph = activeGraph(graph);
  const { cold } = coldView(graph);
  const nodes: ColdNode[] = [];
  for (const fact of graph.facts ?? [])
    if (fact.id !== "origin" && fact.kind !== "navigation" && cold.has(fact.id))
      nodes.push({ kind: "facts", record: fact });
  for (const finding of graph.findings ?? [])
    if (cold.has(finding.id)) nodes.push({ kind: "findings", record: finding });
  return nodes;
}

/**
 * One line per previewed cold node: id + what it says + when it was last used.
 * The line must be enough to decide whether a read is worth it, without pulling
 * the whole cold pool back into the entry.
 */
export function coldNodeLine({ kind, record }: ColdNode): string {
  const last = Math.max(record.last_referenced_round ?? -1, record.last_read_round ?? -1);
  const round = last >= 0 ? `r${last}` : "未引用";
  const conclusion =
    typeof record.conclusion === "string" && record.conclusion.trim()
      ? record.conclusion
      : conclusionFrom(String(record.description ?? ""));
  const text =
    kind === "facts"
      ? `${record.conclusion_inferred ? "（推断）" : ""}${conclusion}`
      : `${firstSentence(String(record.title ?? ""), 100)}：${firstSentence(String(record.description ?? ""), 160)}`;
  return `${record.id} ${round} — ${text}`;
}

/** How many cold lines the entry may carry. The count stays exact; the preview rotates. */
export const COLD_SAMPLE_LIMIT = 8;

export interface ColdSummary {
  count: number;
  sample: string[];
  hint: string;
}

export function coldSummary(graph: Graph, nodes: ColdNode[] = coldNodes(graph)): ColdSummary {
  const limit = Math.max(0, graph.project.hot_limit ?? HOT_LIMIT_DEFAULT);
  if (!limit) return { count: 0, sample: [], hint: "冷却已关闭（hot_limit=0）" };
  // Decision material first.
  const kindRank: Record<ColdKind, number> = { facts: 0, findings: 1 };
  const ordered = [...nodes].sort(
    (a, b) => kindRank[a.kind] - kindRank[b.kind] || String(a.record.id).localeCompare(String(b.record.id)),
  );
  // Advance the window one screen per decision round: every cold node becomes visible
  // within ceil(count/limit) rounds, and a fixed ordering cannot create a permanent tail.
  const start = ordered.length ? ((graph.project.decision_round ?? 0) * COLD_SAMPLE_LIMIT) % ordered.length : 0;
  const sample = ordered.length
    ? [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, COLD_SAMPLE_LIMIT).map(coldNodeLine)
    : [];
  return {
    count: ordered.length,
    sample,
    hint:
      `热节点上限 ${limit} 个 Fact/Finding；冷记录 ${ordered.length} 条（只含 Fact/Finding，默认即超出热预算的那些）；sample 每轮轮换最多 ${COLD_SAMPLE_LIMIT} 条` +
      "（rN=最后被引用/读取的轮次，未引用=从未被引用或读取），完整冷池用 query_graph 无过滤浏览或按 id/关键词检索，" +
      "read_graph 读到即回热；已关闭 Step 与 Evidence 不算冷（数量见 evidence.total），用 query_graph kind=evidence 或证据页检索",
  };
}

export interface EntryChanges extends Omit<ChangesPage, "items"> {}

/**
 * Execute reads the current Step and its direct support, not the whole graph;
 * Review reads the Finding, its source Facts and their original Evidence.
 */
export function executeEntry(graph: Graph, job: Job): Record<string, unknown> {
  graph = activeGraph(graph);
  const step = graph.steps.find((value) => value.id === job.step_id) ?? null;
  const subgoal = graph.goals.find((goal) => goal.id === step?.goal_id);
  const asset = graph.assets.find((item) => item.id === step?.asset_id);
  const factIds = new Set([...(step?.from ?? []), ...(step?.fact_ids ?? []), ...(step?.deleted_output_ids ?? [])]);
  const facts = graph.facts.filter((fact) => factIds.has(fact.id));
  const relations = resolveGraphRelations(graph);
  const producerIds = new Set(facts.flatMap((fact) => relations.facts.get(fact.id)!.producers.map((p) => p.step_id)));
  const producerSteps = graph.steps.filter((step) => producerIds.has(step.id));
  const producerInputs = new Set(producerSteps.flatMap((step) => step.from));
  const findings = graph.findings.filter(
    (finding) =>
      !finding.merged_into &&
      !finding.withdrawn_at &&
      (finding.id === step?.retest_finding_id ||
        finding.step_id === step?.id ||
        finding.revision_step_id === step?.id ||
        finding.from.some((id) => factIds.has(id))),
  );
  // A retest or补证 Step must see the claimed report fields, but the whole set stays
  // within one budget so a handful of long claims cannot crowd out the Step itself.
  const claimCandidates = findings
    .slice()
    .sort((a, b) => claimRank(a, step) - claimRank(b, step) || a.id.localeCompare(b.id));
  const claims = new Map<string, Record<string, unknown>>();
  let claimCharacters = 0;
  for (const finding of claimCandidates) {
    const built = findingClaim(finding);
    // The highest-priority claim (usually the retest target) always fits; later ones
    // share the remaining budget so long claims cannot crowd out the Step.
    if (claims.size && claimCharacters + built.characters > EXECUTE_CLAIM_BUDGET) continue;
    claims.set(finding.id, built.claim);
    claimCharacters += built.characters;
  }
  const candidateIds = new Set(claimCandidates.map((finding) => finding.id));
  const lastSummary = step?.summary ? bounded(step.summary, EXECUTE_LAST_SUMMARY_LIMIT) : null;
  const evidenceIds = new Set([...facts.flatMap((f) => f.evidence_ids), ...findings.flatMap((f) => f.evidence_ids)]);
  const evidence = graph.evidence.filter((item) => evidenceIds.has(item.id));
  return {
    snapshot_revision: graph.revision,
    planning_revision: planningRevision(graph),
    decided_planning_revision: decidedPlanningRevision(graph),
    search_state: searchState(graph),
    observation_revision: graph.observation_revision,
    project_id: graph.project.id,
    goal: graph.goals.find((g) => g.id === "goal")?.description ?? "",
    focus: step
      ? {
          id: step.id,
          description: step.description,
          property: step.property ?? null,
          method_hint: step.method_hint ?? null,
          priority: effectiveStepPriority(graph, step),
          version: step.version ?? 1,
          asset_id: step.asset_id ?? null,
          goal_id: step.goal_id ?? null,
          from: step.from,
          subgoal: subgoal ? { id: subgoal.id, description: subgoal.description, state: subgoal.state } : null,
          reopen_reason: step.reopen_reason ?? null,
          retest_finding_id: step.retest_finding_id ?? null,
          blocked_run_id: step.blocked_run_id ?? null,
          last_summary: lastSummary?.text || null,
          ...(lastSummary?.truncated ? { last_summary_truncated: true } : {}),
        }
      : { id: job.step_id ?? null, description: null },
    asset: asset ? { id: asset.id, hostname: asset.hostname, approval: asset.approval } : null,
    facts: facts.map((fact) => ({
      id: fact.id,
      conclusion: fact.conclusion ?? conclusionFrom(fact.description),
      conclusion_inferred: !fact.conclusion || !!fact.conclusion_inferred,
      status: fact.status ?? "observed",
      description: fact.description,
      evidence_ids: fact.evidence_ids,
      objects: fact.objects ?? [],
      provenance: relations.facts.get(fact.id),
      created_at: fact.created_at ?? null,
    })),
    source_steps: producerSteps.slice(0, EXECUTE_SOURCE_STEP_LIMIT).map((source) => {
      const summary = bounded(source.summary ?? "", EXECUTE_SOURCE_TEXT_LIMIT);
      const closeReason = bounded(source.close_reason ?? "", EXECUTE_SOURCE_TEXT_LIMIT);
      const truncated: string[] = [];
      if (summary.truncated) truncated.push("summary");
      if (closeReason.truncated) truncated.push("close_reason");
      return {
        id: source.id,
        description: source.description,
        from: source.from,
        graph_id: source.graph_id,
        summary: summary.text || null,
        close_reason: closeReason.text || null,
        ...(truncated.length ? { truncated_fields: truncated } : {}),
      };
    }),
    ...(producerSteps.length > EXECUTE_SOURCE_STEP_LIMIT
      ? { source_steps_omitted: producerSteps.length - EXECUTE_SOURCE_STEP_LIMIT }
      : {}),
    deleted_sources:
      graph.deleted_nodes?.filter(
        (ref) =>
          factIds.has(ref.id) || producerIds.has(ref.id) || producerInputs.has(ref.id) || ref.id === step?.goal_id,
      ) ?? [],
    findings: findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      description: finding.description,
      status: finding.status,
      kind: findingKind(finding),
      classification_review_required: classificationReviewRequired(finding, graph),
      review_status: finding.review_status,
      severity: finding.severity ?? null,
      cvss: finding.cvss ?? null,
      evidence_ids: finding.evidence_ids,
      from: finding.from,
      human_feedback: finding.human_feedback ?? null,
      ...(claims.get(finding.id) ?? (candidateIds.has(finding.id) ? { claims_omitted: true } : {})),
    })),
    evidence: evidence.map((item) => ({ id: item.id, title: item.title, mime_type: item.mime_type, size: item.size })),
    hints: (step?.hint_ids ?? [])
      .map((id) => graph.hints.find((hint) => hint.id === id && !hint.withdrawn_at && stepCoversHint(step!, hint)))
      .filter((hint): hint is Graph["hints"][number] => !!hint)
      .map((hint) => ({ id: hint.id, priority: hint.priority ?? 0, content: hint.content, creator: hint.creator })),
    counts: { facts: graph.facts.length, evidence: graph.evidence.length, findings: graph.findings.length },
    failures: { last_error: graph.project.last_error ?? null, blocked_run_id: step?.blocked_run_id ?? null },
    instructions:
      "当前任务的执行视图：Step、直接来源 Fact 全文、相关 Finding 声明（claim:true，是既有声明而非证据，先回读原始证据核对）、生产 Step 的摘要与关闭理由、当前资产与证据元数据。hints 是人工针对本任务的原始指令，必须遵守并体现在事实或摘要里。last_summary 是上一次执行或中断留下的摘要；claims_omitted 或 truncated_fields 表示已截断，用 read_graph 回读。更上游的记录与证据正文用 read_graph / read_evidence 按需读取。",
  };
}

export function reviewEntry(graph: Graph, job: Job): Record<string, unknown> {
  graph = activeGraph(graph);
  const finding = graph.findings.find((value) => value.id === job.finding_id) ?? null;
  const facts = graph.facts.filter((fact) => finding?.from.includes(fact.id));
  const relations = resolveGraphRelations(graph);
  const producerIds = new Set(facts.flatMap((fact) => relations.facts.get(fact.id)!.producers.map((p) => p.step_id)));
  const producerInputs = new Set(graph.steps.filter((step) => producerIds.has(step.id)).flatMap((step) => step.from));
  const evidenceIds = new Set([...(finding?.evidence_ids ?? []), ...facts.flatMap((f) => f.evidence_ids)]);
  const evidence = graph.evidence.filter((item) => evidenceIds.has(item.id));
  const asset = graph.assets.find((item) => item.id === finding?.asset_id);
  return {
    snapshot_revision: graph.revision,
    planning_revision: planningRevision(graph),
    decided_planning_revision: decidedPlanningRevision(graph),
    search_state: searchState(graph),
    observation_revision: graph.observation_revision,
    project_id: graph.project.id,
    goal: graph.goals.find((g) => g.id === "goal")?.description ?? "",
    finding: finding
      ? {
          id: finding.id,
          version: finding.version,
          title: finding.title,
          description: finding.description,
          impact: finding.impact ?? null,
          reproduction: finding.reproduction ?? null,
          remediation: finding.remediation ?? null,
          evidence_ids: finding.evidence_ids,
          from: finding.from,
          kind: findingKind(finding),
          classification_review_required: classificationReviewRequired(finding, graph),
          status: finding.status,
          review_status: finding.review_status,
          severity: finding.severity ?? null,
          severity_reason: finding.severity_reason ?? null,
          cvss: finding.cvss ?? null,
          identity: finding.identity ?? null,
          human_feedback: finding.human_feedback ?? null,
        }
      : { id: job.finding_id ?? null },
    facts: facts.map((fact) => ({
      id: fact.id,
      conclusion: fact.conclusion ?? conclusionFrom(fact.description),
      conclusion_inferred: !fact.conclusion || !!fact.conclusion_inferred,
      status: fact.status ?? "observed",
      description: fact.description,
      evidence_ids: fact.evidence_ids,
      provenance: relations.facts.get(fact.id),
      created_at: fact.created_at ?? null,
    })),
    source_steps: graph.steps
      .filter((step) => producerIds.has(step.id))
      .map((step) => ({
        id: step.id,
        description: step.description,
        from: step.from,
        graph_id: step.graph_id,
      })),
    deleted_sources:
      graph.deleted_nodes?.filter(
        (ref) =>
          finding?.from.includes(ref.id) ||
          producerIds.has(ref.id) ||
          producerInputs.has(ref.id) ||
          ref.id === finding?.step_id ||
          ref.id === finding?.revision_step_id,
      ) ?? [],
    evidence: evidence.map((item) => ({ id: item.id, title: item.title, mime_type: item.mime_type, size: item.size })),
    asset: asset ? { id: asset.id, hostname: asset.hostname, approval: asset.approval } : null,
    reviews: graph.reviews.filter((review) => review.finding_id === finding?.id),
    merged_findings: finding
      ? mergedFindingSources(graph, finding.id).map((source) => ({
          id: source.id,
          title: source.title,
          description: source.description,
          impact: source.impact,
          reproduction: source.reproduction,
          remediation: source.remediation,
          evidence: source.evidence,
          evidence_ids: source.evidence_ids,
          from: source.from,
          kind: findingKind(source),
          previous_severity: source.severity,
          previous_cvss: source.cvss,
          merge_reason: source.merge_reason,
        }))
      : [],
    instructions:
      "Review 视图：只含 Finding、来源 Fact 与原始证据清单。依据 reproduction 核对已有原始证据，不发起目标请求或复测；证据不足返回 needs_evidence，由 Decide 规划后续验证。不要猜 CVSS 分数，不新建 Step / Fact。",
  };
}

export function projectEntry(graph: Graph, focusId: string, changes?: EntryChanges) {
  graph = activeGraph(graph);
  const facts = graph.facts ?? [];
  const steps = graph.steps ?? [];
  const findings = (graph.findings ?? []).filter((f) => !f.merged_into && !f.withdrawn_at);
  const open = steps.filter(unclosedStep);
  const orderedOpen = open.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const reviewIssues = findings.flatMap((finding) => {
    const review = graph.reviews
      .filter((r) => r.finding_id === finding.id && r.finding_version === finding.version)
      .at(-1);
    if (!review || (review.verdict === "pass" && !review.planning_issues?.length)) return [];
    // The Decider must judge this review now; give it the source observations, not
    // only their IDs. The reason is still paged through read_full.
    const sourceFacts = finding.from.slice(0, REVIEW_SOURCE_FACT_LIMIT).map((id) => {
      const fact = facts.find((value) => value.id === id);
      if (!fact) return { id, missing: true };
      const body = bounded(fact.description, REVIEW_SOURCE_TEXT_LIMIT);
      return {
        id,
        conclusion: fact.conclusion ?? conclusionFrom(fact.description),
        description: body.text,
        ...(body.truncated ? { truncated: true } : {}),
      };
    });
    return [
      {
        finding_id: finding.id,
        finding_version: finding.version,
        review_id: review.id,
        verdict: review.verdict,
        reason_preview: firstSentence(review.reason),
        reason_truncated: review.reason.length > SUMMARY_BODY_LIMIT,
        planning_issues:
          review.planning_issues?.map((question, index) => {
            const waiver = reviewIssueWaiver(review, index);
            return {
              index,
              preview: firstSentence(question),
              truncated: question.length > SUMMARY_BODY_LIMIT,
              risk: reviewIssueRisk(question),
              waived: !!waiver,
              ...(waiver ? { waiver_reason: firstSentence(waiver.reason, 160) } : {}),
            };
          }) ?? [],
        source_fact_ids: finding.from,
        source_facts: sourceFacts,
        ...(finding.from.length > REVIEW_SOURCE_FACT_LIMIT
          ? { source_facts_omitted: finding.from.length - REVIEW_SOURCE_FACT_LIMIT }
          : {}),
        evidence_ids: [...new Set([...finding.evidence_ids, ...review.evidence_ids])],
        read_full: { id: review.id },
      },
    ];
  });
  const unresolvedReviewIssueIds = openReviewIssues(graph).map((issue) => `${issue.review.id}#${issue.index}`);
  const relations = resolveGraphRelations(graph);
  const sourceIds = new Set([
    ...steps.flatMap((step) => [
      ...step.from,
      ...(step.deleted_output_ids ?? []),
      ...(step.goal_id ? [step.goal_id] : []),
    ]),
    ...findings.flatMap((finding) => [
      ...finding.from,
      ...[finding.step_id, finding.revision_step_id].filter((id): id is string => !!id),
    ]),
    ...[...relations.facts.values()].flatMap((source) => source.producers.map((producer) => producer.step_id)),
  ]);
  const referenced = new Set<string>();
  for (const step of open)
    for (const factId of step.fact_ids) {
      const fact = facts.find((f) => f.id === factId);
      for (const id of fact?.evidence_ids ?? []) referenced.add(id);
    }
  for (const step of open)
    for (const finding of findings)
      if (finding.step_id === step.id || finding.revision_step_id === step.id)
        for (const id of finding.evidence_ids) referenced.add(id);
  const coldPool = coldNodes(graph);
  const coldIds = new Set(coldPool.map(({ record }) => String(record.id)));
  const cold = coldSummary(graph, coldPool);
  return {
    // The first line is a fact, not a cap: the decider must see progress towards closure.
    unclosed: open.length,
    snapshot_revision: graph.revision,
    planning_revision: planningRevision(graph),
    decided_planning_revision: decidedPlanningRevision(graph),
    search_state: searchState(graph),
    observation_revision: graph.observation_revision,
    decided_revision: graph.decided_revision,
    project_id: graph.project.id,
    decision_round: graph.project.decision_round ?? 0,
    counts: Object.fromEntries(
      (["facts", "steps", "findings", "goals", "hints", "assets", "evidence", "reviews", "bookmarks"] as const).map(
        (kind) => [kind, (graph[kind] ?? []).length],
      ),
    ),
    control: {
      unfinished_steps: open.length,
      executed_steps: open.filter((s) => s.executed_at).length,
      running_steps: open.filter((s) => s.worker).length,
      blocked_steps: open.filter((s) => s.blocked_run_id).length,
      pending_findings: findings.filter((f) => f.review_status === "pending").length,
      review_corrections: findings.filter((f) => ["needs_evidence", "rejected"].includes(f.review_status)).length,
      active_hints: graph.hints.filter((h) => !h.withdrawn_at).length,
      approved_assets: graph.assets.filter((a) => a.approval === "approved").length,
    },
    focus_id: focusId,
    deleted_sources: graph.deleted_nodes?.filter((ref) => sourceIds.has(ref.id)) ?? [],
    goal: graph.goals.find((g) => g.id === "goal")?.description ?? "",
    facts: facts
      .filter((fact) => fact.id === "origin" || fact.kind === "navigation" || !coldIds.has(fact.id))
      .map(factLine),
    steps: orderedOpen.slice(0, OPEN_STEP_PREVIEW_LIMIT).map((s) => stepLine(s, effectiveStepPriority(graph, s))),
    // A lead is a concrete next question, not a confirmed observation. Open
    // leads are the mandatory bridge between execution findings and planning.
    leads: (graph.leads ?? []).filter((lead) => lead.status === "open").map(leadLine),
    ...(orderedOpen.length > OPEN_STEP_PREVIEW_LIMIT
      ? {
          open_step_index: orderedOpen.map((s) => ({
            id: s.id,
            version: s.version ?? 1,
            state: stepState(s),
            asset_id: s.asset_id ?? null,
            goal_id: s.goal_id ?? null,
            hint_ids: s.hint_ids ?? [],
          })),
          steps_preview: {
            total: orderedOpen.length,
            shown: OPEN_STEP_PREVIEW_LIMIT,
            query: { kind: "steps", status: "open", limit: 50 },
            read_full: "read_graph(id); follow next_offset with expected_hash",
          },
        }
      : {}),
    review_issues: reviewIssues,
    // Completion is refused for each remaining entry. The model can point at an
    // executed Step or explain a low-risk dismissal; high-risk issues need a human.
    unresolved_review_issues: unresolvedReviewIssueIds,
    human_feedback: findings
      .filter((f) => f.human_feedback && f.reviewed_version <= f.human_feedback.version)
      .map((f) => ({ finding_id: f.id, ...f.human_feedback })),
    findings: findings.filter((finding) => !coldIds.has(finding.id)).map(findingLine),
    // Exact duplicate groups bypass the hot budget so cold records cannot hide
    // conflicting grades or leave completion with duplicate deliverables.
    finding_duplicates: duplicateFindingGroups(findings).map((group) => ({
      ...group,
      members: group.finding_ids.map((id) => {
        const f = findings.find((f) => f.id === id)!;
        return {
          id,
          version: f.version,
          title: f.title,
          kind: findingKind(f),
          severity: f.severity ?? null,
          review_status: f.review_status,
          cvss: f.cvss ?? null,
        };
      }),
    })),
    finding_related: relatedFindingGroups(findings).map((group) => ({
      ...group,
      members: group.finding_ids.map((id) => {
        const finding = findings.find((f) => f.id === id)!;
        return {
          id,
          version: finding.version,
          title: finding.title,
          identity: finding.identity,
          evidence_ids: finding.evidence_ids,
        };
      }),
      instruction:
        "入口相同不等于漏洞重复。核对根因、修复方式和独立影响；重复结论合并，攻击链或附加配置问题说明关联与新增影响。",
    })),
    goals: graph.goals.filter((g) => g.id !== "goal").map(goalLine),
    hints: graph.hints
      .filter((h) => !h.withdrawn_at)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      .map((h) => hintLine(h, steps)),
    // Completion is refused while this list is non-empty, so the Decider gets an
    // unambiguous to-do list instead of having to infer coverage from the text.
    unaddressed_hints: graph.hints
      .filter((h) => !h.withdrawn_at && !h.resolved && !steps.some((s) => stepCoversHint(s, h)))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      .map((h) => h.id),
    // Every open Hint blocks `complete`, including one already carried by a Step:
    // a model note is advice, and only a human can confirm the directive is settled.
    unresolved_hints: graph.hints
      .filter((h) => !h.withdrawn_at && !h.resolved)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      .map((h) => h.id),
    // Completion must account for every host+path the graph already observed,
    // so the checklist is complete rather than silently truncated.
    coverage_surfaces: coverageSurfaces(graph).map((item) => ({
      surface: item.surface,
      facts: item.fact_ids,
      evidence_ids: item.evidence_ids.slice(0, 5),
      parameters: item.parameters,
    })),
    // A cooled asset stays approved but leaves the listing: the Decider said it is irrelevant,
    // so it must stop costing context every round. read_graph still returns it in full.
    assets: graph.assets.filter((a) => a.cooldown_override !== "cooled").map(assetLine),
    cooled_assets: graph.assets
      .filter((a) => a.cooldown_override === "cooled")
      .map((a) => `${a.id}:${a.hostname}${a.revisit_when ? `（重访：${firstSentence(a.revisit_when, 60)}）` : ""}`),
    evidence: {
      total: graph.evidence.length,
      // Evidence is raw material: only its count and the ids an open Step relies on enter the entry.
      referenced_ids: [...referenced],
    },
    reviews: {
      total: graph.reviews.length,
      pass: graph.reviews.filter((r) => r.verdict === "pass").length,
      needs_evidence: graph.reviews.filter((r) => r.verdict === "needs_evidence").length,
      rejected: graph.reviews.filter((r) => r.verdict === "rejected").length,
    },
    // Failures are visible to the next Decider instead of only to the operator UI.
    failures: {
      last_error: graph.project.last_error ?? null,
      decide_conflicts: graph.project.decide_conflicts ?? 0,
      model_failures: graph.project.model_failures ?? 0,
      failed_steps: open
        .filter((s) => s.blocked_run_id)
        .map((s) => `${s.id}: ${firstSentence(s.summary || "执行中断", 160)}`),
    },
    cold,
    ...(changes ? { changes } : {}),
    instructions:
      "未关闭 Step 超过 200 条时，open_step_index 保留全部 ID/版本，steps 是前 200 条预览；按 steps_preview.query 分页或按 ID 读完整问题。conclusion 完整，正文只保留首句（≤300）。review_issues 给出当前审核问题（review_id#issue_index、risk）、直接来源 Fact 全文（超长标 truncated）与证据 ID，审核理由全文用 review_id 回读；unresolved_review_issues 未处置前 complete 会被拒绝：complete.review_issues 的 addressed 必须指向审核之后执行并关闭的 Step，waived 必须写理由，授权/越权/个人信息类高风险问题只能由人工在审核页豁免。执行完不等于答够，只能由你用 closes 关闭。用 read_graph 按 id 读原始记录与完整正文，query_graph 检索全部历史（含已关闭节点与证据正文）。failures 是上一轮的失败清单（最后错误、决策冲突、模型失败、被阻塞的 Step），先处理它再规划。assets 是可规划的资产；cooled_assets 是你判定与当前目标无关、已移出列表的资产（仍是 approved，可用 submit_decisions 的 assets 恢复）。hints 按 p 从大到小（数字越大越先）；unaddressed_hints 里的 Hint 还没有任何 Step 承载，应建 Step 或在 hint_notes 说明理由。unresolved_hints 里的每条 Hint 都尚未由人工确认；hint_notes 只是建议，不会关闭 Hint，只有人工在提示面板确认后 complete 才会通过。leads 是执行阶段发现、必须处置的下一问题：用新 Step 的 lead_ids 落实，或在 lead_dispositions 用 waiver_reason 说明不追究；存在 open lead 时 complete 会被拒绝。complete 的 coverage 还要逐项覆盖 coverage_surfaces（tested 带 evidence_ids，waived 带 reason，na 说明不适用）。",
  };
}
