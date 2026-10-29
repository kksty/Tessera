import type { Fact, Finding, Graph, Job, Step } from "../../protocol/src/index.js";
import { mergedFindingSources } from "./finding-merges.js";
import { resolveGraphRelations } from "../../protocol/src/graph-relations.js";
import { findingKind, classificationReviewRequired } from "../../protocol/src/finding-policy.js";
import { planningRevision, decidedPlanningRevision, searchState } from "../../protocol/src/planning.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { conclusionFrom } from "./entry-lines.js";

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
