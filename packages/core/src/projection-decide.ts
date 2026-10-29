import type { Fact, Graph, Step } from "../../protocol/src/index.js";
import { effectiveStepPriority, stepCoversHint } from "./hint-coverage.js";
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
    const shown = rows.slice(0, 15);
    const rest = rows.slice(15);
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
    steps: orderedOpen.slice(0, OPEN_STEP_PREVIEW_LIMIT).map((s) => stepLine(s, effectiveStepPriority(graph, s))),
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
      "未关闭 Step 超过 200 条时，open_step_index 保留全部 ID/版本，steps 是前 200 条预览；按 steps_preview.query 分页或按 ID 读完整问题。conclusion 完整，正文只保留首句（≤300）。review_issues 给出当前审核问题（review_id#issue_index、risk）、直接来源 Fact 全文（超长标 truncated）与证据 ID，审核理由全文用 review_id 回读；unresolved_review_issues 未处置前 complete 会被拒绝：complete.review_issues 的 addressed 必须指向审核之后执行并关闭的 Step，waived 必须写理由，授权/越权/个人信息类高风险问题只能由人工在审核页豁免。执行完不等于答够，只能由你用 closes 关闭。用 read_graph 按 id 读原始记录与完整正文，query_graph 检索全部历史（含已关闭节点与证据正文）。failures 是上一轮的失败清单（最后错误、决策冲突、模型失败、被阻塞的 Step），先处理它再规划。assets 是可规划的资产；cooled_assets 是你判定与当前目标无关、已移出列表的资产（仍是 approved，可用 submit_decisions 的 assets 恢复）。hints 按 p 从大到小（数字越大越先）；unaddressed_hints 里的 Hint 还没有任何 Step 承载，应建 Step 或在 hint_notes 说明理由。unresolved_hints 里的每条 Hint 尚未处置；用 Step 的 hint_ids 承载它，或用 hint_notes 写明该提示如何落实——带说明的 hint_notes 会让你（模型）关闭该 Hint 从而允许 complete；人工也可在提示面板确认或撤回。leads 是执行阶段留下的候选问题，不阻塞完成：值得追的用新 Step 的 lead_ids 落实（受每轮新增上限约束），不值得的在 lead_dispositions 用 waiver_reason 说明，其余可以留在列表里。每轮新增 Step 数与在途 Step 数都有上限，超限的规划会被拒绝：先把未开始的 Step 用 updates 改写或 discard，或等执行完再规划；若在途数已经超过上限，先单独提交一个只含 closes/discard（不带任何新 steps）的批次把它降到上限以内，再规划新工作——只做结算、不新增 Step 的批次永远放行。step_costs 给出每个 Step 已消耗的 token 与它产出的事实/发现数，追加投入前先判断再做一轮会不会改变结论。修正已有 Fact 的措辞、统计或 request/parameter_sources 用 revise_fact 原地修订，不要为记账新建 Step。complete 的 coverage 还要逐项覆盖 coverage_surfaces（tested 带 evidence_ids，waived 带 reason，na 说明不适用）。",
  };
}
