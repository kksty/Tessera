import type { Finding, Graph } from "./models.js";
import { findingAssets } from "./asset-scope.js";
import { classificationReviewRequired } from "./finding-policy.js";

/** Stable IDs can exceed three digits; compare their numeric suffix without precision loss. */
export function compareFindingIds(a: Pick<Finding, "id">, b: Pick<Finding, "id">) {
  const left = /^v(\d+)$/.exec(a.id), right = /^v(\d+)$/.exec(b.id);
  if (left && right) {
    const x = BigInt(left[1]), y = BigInt(right[1]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export type ReviewGate = "ready" | "reviewing" | "inactive" | "current" | "excluded" |
  "source_unfinished" | "asset_unapproved" | "backoff" | "review_limit";

export function reviewGate(graph: Graph, finding: Finding, maxReviews = 1, at = Date.now()): ReviewGate {
  if (finding.deleted || finding.merged_into || finding.withdrawn_at) return "excluded";
  if (finding.review_worker) return "reviewing";
  if (finding.version <= finding.reviewed_version && !classificationReviewRequired(finding, graph)) return "current";
  if (graph.project.status !== "active") return "inactive";
  const sourceId = finding.revision_step_id || finding.step_id;
  const source = graph.steps.find(s => s.id === sourceId);
  const sourceDeleted = source?.deleted || graph.deleted_nodes?.some(ref => ref.id === sourceId);
  if (sourceId && !sourceDeleted && !(source?.executed_at || source?.concluded_at)) return "source_unfinished";
  if (findingAssets(graph, finding).some(id => !graph.assets.some(a => a.id === id && a.approval === "approved")))
    return "asset_unapproved";
  if ([graph.project.model_retry_at, finding.retry_at].some(time => time && !(Date.parse(time) <= at))) return "backoff";
  if (graph.findings.filter(f => f.review_worker).length >= maxReviews) return "review_limit";
  return "ready";
}

/** Claimable entries lead the displayed queue in exactly the order used by claim(). */
export function pendingReviews(graph: Graph, maxReviews = 1, at = Date.now()) {
  return graph.findings.filter(f => !f.deleted && !f.merged_into && !f.withdrawn_at &&
    (f.review_status === "pending" || f.reviewed_version !== f.version || classificationReviewRequired(f, graph)))
    .map(finding => ({ finding, gate: reviewGate(graph, finding, maxReviews, at) }))
    .sort((a, b) => Number(b.gate === "ready") - Number(a.gate === "ready") || compareFindingIds(a.finding, b.finding));
}
