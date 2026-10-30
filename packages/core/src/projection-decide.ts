import type { Fact, Graph, Step } from "../../protocol/src/index.js";
import { effectiveStepPriority, stepCoversHint } from "./hint-coverage.js";
import { unmetDependencies } from "./step-chain.js";
import { coverageSurfaces } from "../../protocol/src/coverage.js";
import { duplicateFindingGroups, relatedFindingGroups } from "./finding-merges.js";
import { resolveGraphRelations } from "../../protocol/src/graph-relations.js";
import { findingKind } from "../../protocol/src/finding-policy.js";
import { planningRevision, decidedPlanningRevision, searchState } from "../../protocol/src/planning.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { reviewIssueRisk, reviewIssueWaiver } from "../../protocol/src/review-issues.js";
import { openReviewIssues } from "./review-issues.js";
import { firstSentence, conclusionFrom } from "./entry-lines.js";
import { stepState, unclosedStep, factLine } from "./entry-lines.js";
import { findingLine } from "./entry-lines.js";
import { coldView, coldNodes, coldSummary } from "./entry-lines.js";
import {
  EntryChanges,
  OPEN_STEP_PREVIEW_LIMIT,
  REVIEW_SOURCE_FACT_LIMIT,
  REVIEW_SOURCE_TEXT_LIMIT,
  SUMMARY_BODY_LIMIT,
  assetLine,
  bounded,
  goalLine,
  hintLine,
  leadLine,
  stepLine,
} from "./projection-lines.js";

/**
 * Effective planning budget for this Decide round. `0` means unlimited, matching
 * the server config; the entry carries the real numbers so the decider plans
 * against the same constraint the settlement enforces instead of guessing.
 */
export interface StepLimits {
  max_new_steps_per_round: number;
  max_open_steps: number;
}

export function projectEntry(graph: Graph, focusId: string, changes?: EntryChanges, limits?: StepLimits) {
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
  // Focused work is mandatory: the current Step's inputs and the focused Finding
  // stay hot. Other open Steps' inputs are deliberately NOT forced hot; their ids
  // live in open_step_index and read_graph brings them back on demand.
  const view = coldView(graph, [focusId]);
  const coldPool = coldNodes(graph, [focusId], view);
  const coldIds = view.cold;
  const cold = coldSummary(graph, coldPool, view);
  // What each Step has already cost and produced. Decide cannot price "one more
  // round" without it: a step that burned 20M tokens for one informational note
  // looks exactly like a productive one in the node list alone.
  const stepCosts = (() => {
    const per = new Map<string, { runs: Set<string>; input: number; output: number }>();
    for (const usage of graph.usage ?? []) {
      if (usage.kind !== "execute" || !usage.node_id) continue;
      const entry = per.get(usage.node_id) ?? { runs: new Set<string>(), input: 0, output: 0 };
      if (usage.run_id) entry.runs.add(usage.run_id);
      entry.input += usage.input ?? 0;
      entry.output += usage.output ?? 0;
      per.set(usage.node_id, entry);
    }
    const compact = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
    const rows = [...per.entries()]
      .map(([stepId, cost]) => {
        const step = steps.find((s) => s.id === stepId);
        const produced = step?.fact_ids.length ?? 0;
        const claimed = findings.filter((f) => f.step_id === stepId || f.revision_step_id === stepId).length;
        return {
          stepId,
          input: cost.input,
          output: cost.output,
          line: `${stepId} 运行${cost.runs.size}次 输入${compact(cost.input)} 输出${compact(cost.output)} 事实${produced} 发现${claimed}`,
        };
      })
      .filter((row) => row.input > 0)
      .sort((a, b) => b.input - a.input);
    // Cost is an anomaly signal, not a budget objective: show only the most
    // expensive turns instead of turning every planning view into an invoice.
    // The full per-Step history stays in diagnostics.
    const shown = rows.slice(0, 5);
    const rest = rows.slice(5);
    return {
      total_input: rows.reduce((sum, row) => sum + row.input, 0),
      total_output: rows.reduce((sum, row) => sum + row.output, 0),
      steps: shown.map((row) => row.line),
      ...(rest.length ? { more_steps: rest.length, more_input: rest.reduce((sum, row) => sum + row.input, 0) } : {}),
    };
  })();
  return {
    // The first line is a fact, not a cap: the decider must see progress towards closure.
    unclosed: open.length,
    // Planning is a search decision, not a queue-quota puzzle: give the decider
    // the same hard numbers the settlement enforces (0 = unlimited) so it can
    // spend attention on what to ask next instead of discovering the cap via 422.
    ...(limits
      ? {
          limits: {
            max_new_steps_per_round: limits.max_new_steps_per_round,
            max_open_steps: limits.max_open_steps,
            open_steps: open.length,
            at_open_cap: limits.max_open_steps > 0 && open.length >= limits.max_open_steps,
          },
        }
      : {}),
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
      // Informational notes are background, not delivery progress: count them apart.
      confirmed_vulnerabilities: findings.filter(
        (f) => f.review_status === "pass" && findingKind(f) === "vulnerability",
      ).length,
      confirmed_informational: findings.filter((f) => f.review_status === "pass" && findingKind(f) === "informational")
        .length,
    },
    focus_id: focusId,
    deleted_sources: graph.deleted_nodes?.filter((ref) => sourceIds.has(ref.id)) ?? [],
    goal: graph.goals.find((g) => g.id === "goal")?.description ?? "",
    facts: facts
      .filter((fact) => fact.id === "origin" || fact.kind === "navigation" || !coldIds.has(fact.id))
      .map(factLine),
    steps: orderedOpen
      .slice(0, OPEN_STEP_PREVIEW_LIMIT)
      .map((s) => stepLine(s, effectiveStepPriority(graph, s), unmetDependencies(graph, s))),
    // A lead is a concrete next question, not a confirmed observation. Open
    // leads are the mandatory bridge between execution findings and planning.
    // A lead is a candidate next question, never a checklist item: it does not
    // block completion. The list is capped so a long tail of stale suggestions
    // stops crowding the entry; anything omitted is one read_graph away.
    leads: (graph.leads ?? [])
      .filter((lead) => lead.status === "open")
      .slice(0, 20)
      .map(leadLine),
    open_leads_total: (graph.leads ?? []).filter((lead) => lead.status === "open").length,
    step_costs: stepCosts,
    ...(orderedOpen.length > OPEN_STEP_PREVIEW_LIMIT
      ? {
          open_step_index: orderedOpen.map((s) => ({
            id: s.id,
            version: s.version ?? 1,
            state: stepState(s),
            test_domain: s.test_domain ?? null,
            asset_id: s.asset_id ?? null,
            goal_id: s.goal_id ?? null,
            hint_ids: s.hint_ids ?? [],
            ...(s.depends_on?.length ? { depends_on: s.depends_on, blocked_by: unmetDependencies(graph, s) } : {}),
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
    // A Hint still open blocks `complete` only until it is disposed of: either a
    // Step carries it, the Decider explains closure in `hint_notes` (model closes
    // it), or a human confirms it in the panel.
    unresolved_hints: graph.hints
      .filter((h) => !h.withdrawn_at && !h.resolved)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
      .map((h) => h.id),
    // Completion must account for every host+path the graph already observed,
    // so the checklist is complete rather than silently truncated. Only the
    // surface and its source Facts enter the entry: 198 surfaces with up to five
    // evidence ids each cost ~37k characters, while the evidence ids are one
    // read_graph/query_graph away and are supplied by the model in `complete`.
    coverage_surfaces: coverageSurfaces(graph).map((item) => ({
      surface: item.surface,
      facts: item.fact_ids,
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
      "未关闭 Step 超过 200 条时，open_step_index 保留全部 ID/版本，steps 是前 200 条预览；按 steps_preview.query 分页或按 ID 读完整问题。用 read_graph 按 id 读原始记录与完整正文，query_graph 检索全部历史。failures 是上一轮失败清单（最后错误、决策冲突、模型失败、被阻塞的 Step），先处理再规划。step_costs 只列消耗最高的几轮，用来识别异常，不是预算目标；limits 是本轮真实规划预算（0 表示不限）。complete 的 coverage 必须逐项覆盖 coverage_surfaces（tested 带 evidence_ids，waived 带 reason，na 说明不适用）。",
  };
}
