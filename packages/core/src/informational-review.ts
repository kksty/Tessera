import type { Finding, Graph, Review } from "../../protocol/src/index.js";

const now = () => new Date().toISOString();

function nextReviewId(reviews: { id: string }[]) {
  let highest = 0;
  for (const review of reviews) highest = Math.max(highest, Number(review.id.slice(1)) || 0);
  return `r${String(highest + 1).padStart(3, "0")}`;
}

/**
 * The operator limited Review to vulnerability claims. An explicitly
 * informational Finding that already cites raw evidence is accepted as-is:
 * it enters no vulnerability library, risk total or report, and no Review run
 * is spent on a classification that cannot become one. A real `Review` record
 * is still written so the finding's history and later operator actions agree.
 */
export function acceptInformational(graph: Graph, finding: Finding) {
  finding.kind = "informational";
  finding.review_exempt = "informational";
  finding.review_status = "pass";
  finding.status = "confirmed";
  finding.reviewed_version = finding.version;
  finding.severity = null;
  finding.severity_reason = null;
  finding.cvss = null;
  finding.severity_before_review = undefined;
  finding.severity_reason_before_review = undefined;
  finding.review_worker = null;
  finding.review_heartbeat = null;
  finding.review_run_id = undefined;
  finding.retry_at = undefined;
  const review: Review = {
    source: "system",
    kind: "informational",
    id: nextReviewId(graph.reviews),
    finding_id: finding.id,
    finding_version: finding.version,
    verdict: "pass",
    reason: "信息类免审：当前审核范围只覆盖漏洞类。",
    evidence_ids: [...finding.evidence_ids],
    disputed_fact_ids: [],
    created_at: now(),
    worker: "system",
  };
  graph.reviews.push(review);
}

/**
 * Eligibility is deliberately narrow: an explicit information class that cites
 * evidence and carries no unresolved human direction. Unclassified or
 * evidence-free candidates still need Review, which is where classification and
 * missing proof are established.
 */
export function informationalAwaitingReview(finding: Finding) {
  return (
    !finding.deleted &&
    !finding.merged_into &&
    !finding.withdrawn_at &&
    !finding.review_worker &&
    finding.review_status === "pending" &&
    !finding.human_feedback &&
    // An explicit operator request outranks the platform-wide exemption.
    !finding.review_requested &&
    finding.kind === "informational" &&
    finding.evidence_ids.length > 0
  );
}
