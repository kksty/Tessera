import type { Fact, Finding, Graph, Step } from "../../protocol/src/index.js";
import { classificationReviewRequired, findingKind } from "../../protocol/src/finding-policy.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";

/**
 * Entry-line rendering and the hot/cold budget.
 *
 * This module deliberately depends only on the protocol package so the browser
 * can import it. `projection.ts` pulls in `finding-merges`, which imports
 * `node:crypto`; importing the projection from the web bundle breaks Vite.
 */
export const SUMMARY_BODY_LIMIT = 300;

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
  const scope = fact.negative_scope?.attempted?.length
    ? ` 范围：尝试${fact.negative_scope.attempted.length}项（${firstSentence(fact.negative_scope.attempted[0], 120)}）；未覆盖：${fact.negative_scope.not_tested?.length ? firstSentence(fact.negative_scope.not_tested[0], 120) : "未记录"}；自评置信${fact.negative_scope.confidence}（详情读 Fact）`
    : status === "not_observed"
      ? " ⚠ 缺负向范围（本次未观测，不代表方向穷尽）"
      : "";
  const evidence = fact.evidence_ids.length
    ? ` 证据：${fact.evidence_ids.slice(0, 5).join(",")}${fact.evidence_ids.length > 5 ? "…（详情读 Fact）" : ""}`
    : " 证据：未引用";
  return `${fact.id}${objects} ${status} ${inferred}${conclusion} — ${body}${request}${sources}${scope}${evidence}`;
}

export function findingLine(finding: Finding): string {
  const objects = finding.asset_id ? ` [${finding.asset_id}]` : "";
  const severity = finding.severity ? ` ${finding.severity}` : "";
  const cvss = finding.cvss ? ` cvss ${finding.cvss.score.toFixed(1)}` : "";
  return `${finding.id}${objects} v${finding.version} ${findingState(finding)} kind=${findingKind(finding) ?? "null"}${classificationReviewRequired(finding) ? " needs_classification_review" : ""}${severity}${cvss} — ${firstSentence(finding.title, 120)}：${firstSentence(finding.description)}`;
}

/** Legacy hot budget: projects that never stored one keep the old 200-node window. */
export const HOT_LIMIT_DEFAULT = 200;
/** New projects start at 80 nodes; see the entry-budget design in the fix plan. */
export const HOT_LIMIT_RECOMMENDED = 80;
/** Characters allowed for the entry's Fact/Finding lines. 0 disables the character budget. */
export const HOT_CHAR_LIMIT_DEFAULT = 64_000;

export type ColdKind = "facts" | "findings";
export interface ColdNode {
  kind: ColdKind;
  record: Record<string, any>;
}
export interface HotStats {
  /** Facts/Findings actually listed in the entry (mandatory included). */
  nodes: number;
  /** Characters of their entry lines. */
  chars: number;
  /** Mandatory nodes that cannot be cooled (focus inputs, pending-review sources, pinned). */
  mandatory: number;
  /** True when the mandatory set alone exceeds a budget; the entry still shows it. */
  over_budget: boolean;
}
export interface ColdView {
  disabled: boolean;
  limit: number;
  char_limit: number;
  cold: Set<string>;
  hot: HotStats;
}

/**
 * Hot/cold is a working-set decision, not a time threshold: the entry keeps the
 * most recently used Facts/Findings under BOTH budgets (nodes and characters).
 * Only the focused Step's inputs, pending-review sources and pinned nodes are
 * mandatory. Inputs of every other open Step are NOT forced hot: `open_step_index`
 * already carries their ids, and read_graph/query_graph retrieve them on demand,
 * otherwise 25 open Steps defeat the budget.
 *
 * Closed Steps and Evidence are never cold nodes; they are history reached through
 * query_graph/evidence pages. Never-used nodes rank last and are still reachable.
 */
export function coldView(graph: Graph, focus: string[] = []): ColdView {
  graph = activeGraph(graph);
  const limit = Math.max(0, graph.project.hot_limit ?? HOT_LIMIT_DEFAULT);
  const charLimit = Math.max(0, graph.project.hot_char_limit ?? HOT_CHAR_LIMIT_DEFAULT);
  const cold = new Set<string>();
  const empty: HotStats = { nodes: 0, chars: 0, mandatory: 0, over_budget: false };
  if (!limit) return { disabled: true, limit: 0, char_limit: charLimit, cold, hot: empty };
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
  const focused = new Set(focus);
  const focusedIds = new Set([
    ...graph.steps.filter((step) => focused.has(step.id) && unclosedStep(step)).map((step) => step.id),
    ...graph.findings.filter((finding) => focused.has(finding.id)).map((finding) => finding.id),
  ]);
  const directFacts = new Set([
    ...graph.steps.filter((step) => focusedIds.has(step.id)).flatMap((step) => [...step.from, ...step.fact_ids]),
    ...reviewFindings.flatMap((f) => f.from),
    ...graph.findings.filter((f) => focusedIds.has(f.id)).flatMap((f) => f.from),
  ]);
  const lines = new Map<string, number>();
  const lineChars = (record: Record<string, any>, kind: ColdKind) => {
    const key = String(record.id);
    const cached = lines.get(key);
    if (cached !== undefined) return cached;
    const length = kind === "facts" ? factLine(record as Fact).length : findingLine(record as Finding).length;
    lines.set(key, length);
    return length;
  };
  const candidates: { id: string; last: number; created: string; chars: number }[] = [];
  // origin and navigation are anchors, always listed and never counted against
  // the Fact/Finding budget (matching the pre-budget behaviour).
  let nodes = 0;
  let chars = 0;
  let mandatory = 0;
  let mandatoryChars = 0;
  const mandatoryIds = new Set<string>();
  const consider = (record: Record<string, any>, kind: ColdKind, last: number) => {
    const id = String(record.id);
    if (record.cooldown_override === "pinned" || directFacts.has(id)) {
      if (mandatoryIds.has(id)) return;
      mandatoryIds.add(id);
      mandatory++;
      mandatoryChars += lineChars(record, kind);
      return;
    }
    if (record.cooldown_override === "cooled") {
      cold.add(id);
      return;
    }
    candidates.push({ id, last, created: String(record.created_at ?? ""), chars: lineChars(record, kind) });
  };
  for (const fact of graph.facts ?? []) {
    if (fact.id === "origin" || fact.kind === "navigation") continue;
    consider(fact, "facts", Math.max(fact.last_referenced_round ?? -1, fact.last_read_round ?? -1));
  }
  for (const finding of graph.findings ?? []) {
    // A Finding is the deliverable of its Step: while that Step is open, the Finding
    // is part of the open work and must not disappear from the entry with it.
    const stepId = finding.step_id ?? finding.revision_step_id;
    if ((stepId && openSteps.has(stepId)) || reviewFindings.some((f) => f.id === finding.id)) continue;
    consider(finding, "findings", Math.max(finding.last_referenced_round ?? -1, finding.last_read_round ?? -1));
  }
  // Most recently used first; creation order is the deterministic tiebreaker.
  candidates.sort((a, b) => b.last - a.last || a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  nodes += mandatory;
  chars += mandatoryChars;
  const overBudget = nodes > limit || (charLimit > 0 && chars > charLimit);
  for (const candidate of candidates) {
    if (nodes + 1 > limit || (charLimit > 0 && chars + candidate.chars > charLimit)) {
      cold.add(candidate.id);
      continue;
    }
    nodes++;
    chars += candidate.chars;
  }
  return {
    disabled: false,
    limit,
    char_limit: charLimit,
    cold,
    hot: { nodes, chars, mandatory, over_budget: overBudget },
  };
}

/** Compatibility helper for single-node checks; prefer coldView() when checking many. */
export function isCold(
  graph: Graph,
  node: { id: string; cooldown_override?: string },
  open = false,
  focus: string[] = [],
): boolean {
  if (open) return false;
  return coldView(graph, focus).cold.has(node.id);
}

/** The cold pool, defined once so the entry count, the preview and peek cannot drift apart. */
export function coldNodes(graph: Graph, focus: string[] = [], view?: ColdView): ColdNode[] {
  graph = activeGraph(graph);
  const { cold } = view ?? coldView(graph, focus);
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
  hot?: HotStats;
}

export function coldSummary(graph: Graph, nodes: ColdNode[] = coldNodes(graph), view = coldView(graph)): ColdSummary {
  const { limit, char_limit: charLimit, hot } = view;
  if (!limit) return { count: 0, sample: [], hint: "冷却已关闭（hot_limit=0）", hot };
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
  const budget = charLimit > 0 ? `${hot.chars}/${charLimit} 字符` : `${hot.chars} 字符（未设上限）`;
  return {
    count: ordered.length,
    sample,
    hot,
    hint:
      `热节点上限 ${limit} 个 Fact/Finding，入口已用 ${hot.nodes} 个、${budget}` +
      `${hot.mandatory ? `（其中 ${hot.mandatory} 个必显：当前焦点输入/待审来源/pinned）` : ""}` +
      `${hot.over_budget ? "；必显节点已超出预算，建议关闭或合并 Step" : ""}` +
      `；冷记录 ${ordered.length} 条（只含 Fact/Finding，默认即超出热预算的那些）；sample 每轮轮换最多 ${COLD_SAMPLE_LIMIT} 条` +
      "（rN=最后被引用/读取的轮次，未引用=从未被引用或读取），完整冷池用 query_graph 无过滤浏览或按 id/关键词检索，" +
      "read_graph 读到即回热；已关闭 Step 与 Evidence 不算冷（数量见 evidence.total），用 query_graph kind=evidence 或证据页检索",
  };
}
