import type { Fact, Finding, Graph, Job, Step } from "../../protocol/src/index.js";
import { effectiveStepPriority, stepCoversHint } from "./hint-coverage.js";
import { resolveGraphRelations } from "../../protocol/src/graph-relations.js";
import { findingKind, classificationReviewRequired } from "../../protocol/src/finding-policy.js";
import { planningRevision, decidedPlanningRevision, searchState } from "../../protocol/src/planning.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { conclusionFrom } from "./entry-lines.js";
import {
  EXECUTE_CLAIM_BUDGET,
  EXECUTE_LAST_SUMMARY_LIMIT,
  EXECUTE_SOURCE_STEP_LIMIT,
  EXECUTE_SOURCE_TEXT_LIMIT,
  bounded,
  claimRank,
  findingClaim,
} from "./projection-lines.js";

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
