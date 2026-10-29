import type { Asset, Finding, Goal, Graph, Lead, Step } from "../../protocol/src/index.js";
import type { ChangesPage } from "./memory-changes.js";
import { stepCoversHint } from "./hint-coverage.js";
import { firstSentence, conclusionFrom } from "./entry-lines.js";
import { stepState, unclosedStep, findingState, factLine } from "./entry-lines.js";
import { findingLine } from "./entry-lines.js";
import { coldView, coldNodes, coldSummary } from "./entry-lines.js";

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

export const EXECUTE_LAST_SUMMARY_LIMIT = 1000;

export const EXECUTE_SOURCE_STEP_LIMIT = 3;

export const EXECUTE_SOURCE_TEXT_LIMIT = 600;

export const REVIEW_SOURCE_FACT_LIMIT = 3;

export const REVIEW_SOURCE_TEXT_LIMIT = 2000;

export { firstSentence, conclusionFrom } from "./entry-lines.js";

export function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  const source = text.trim();
  return source.length > limit
    ? { text: `${source.slice(0, limit)}…`, truncated: true }
    : { text: source, truncated: false };
}

/** Retest target first, then the Finding this Step revises or produced, then other direct claims. */
export function claimRank(finding: Finding, step: Step | null): number {
  if (!step) return 9;
  if (finding.id === step.retest_finding_id) return 0;
  if (finding.revision_step_id === step.id) return 1;
  if (finding.step_id === step.id) return 2;
  return 3;
}

/** A Finding is a claim, not Evidence: keep the report fields an executor cannot infer. */
export function findingClaim(finding: Finding): { claim: Record<string, unknown>; characters: number } {
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

export { stepState, unclosedStep, findingState, factLine } from "./entry-lines.js";

export type { StepState } from "./entry-lines.js";

export function stepLine(step: Step, priority = step.priority): string {
  const objects = step.asset_id ? ` [${step.asset_id}]` : "";
  // 分类是可选短码：已填的 Step 带 [recon]，未填不带，模型由此看出哪些旧任务还没分类。
  const domain = step.test_domain ? ` [${step.test_domain}]` : "";
  const from = step.from.length ? ` ← ${step.from.join(",")}` : "";
  const outputs = step.fact_ids.length ? ` → ${step.fact_ids.join(",")}` : "";
  const summary = step.summary ? ` 执行摘要：${firstSentence(step.summary)}` : "";
  const reason = step.close_reason ? ` 关闭理由：${firstSentence(step.close_reason, 120)}` : "";
  const reopen = step.reopen_reason ? ` 重开理由：${firstSentence(step.reopen_reason, 120)}` : "";
  const property = step.property ? ` 属性：${firstSentence(step.property, 200)}` : "";
  const method = step.method_hint ? ` 方法建议：${firstSentence(step.method_hint, 160)}` : "";
  return `${step.id}${objects} ${stepState(step)} p${priority} v${step.version ?? 1}${domain}${from}${outputs} — ${firstSentence(step.description)}${property}${method}${summary}${reason}${reopen}`;
}

export { findingLine } from "./entry-lines.js";

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
    ? `${hint.resolved_by === "decide" ? "已按模型说明关闭" : "已人工确认"}：${firstSentence(hint.resolved.note, 120)}`
    : covered.length
      ? `→ ${covered.join(",")}（待 hint_notes 说明或人工确认）`
      : advice
        ? `待处置（Decide 建议：${firstSentence(advice.note, 120)}）`
        : "待处置";
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

export {
  HOT_LIMIT_DEFAULT,
  HOT_LIMIT_RECOMMENDED,
  HOT_CHAR_LIMIT_DEFAULT,
  COLD_SAMPLE_LIMIT,
  coldView,
  isCold,
  coldNodes,
  coldNodeLine,
  coldSummary,
} from "./entry-lines.js";

export type { ColdKind, ColdNode, HotStats, ColdView, ColdSummary } from "./entry-lines.js";

/**
 * Per-section character counts for the entry, so the budget can be measured
 * before it is tightened. `other` is filled by the caller from the total.
 */
export function projectionSections(entry: Record<string, unknown>): Record<string, number> {
  const size = (value: unknown) => (value === undefined ? 0 : JSON.stringify(value).length);
  return {
    facts: size(entry.facts),
    steps: size(entry.steps) + size(entry.open_step_index) + size(entry.steps_preview),
    findings: size(entry.findings),
    finding_groups: size(entry.finding_related) + size(entry.finding_duplicates),
    leads: size(entry.leads),
    review_issues: size(entry.review_issues),
    hints: size(entry.hints),
    coverage_surfaces: size(entry.coverage_surfaces),
    step_costs: size(entry.step_costs),
    cold: size(entry.cold),
    instructions: size(entry.instructions),
  };
}

export interface EntryChanges extends Omit<ChangesPage, "items"> {}
