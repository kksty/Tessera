import type { Finding, OverviewFinding } from "../../../packages/protocol/src/index.js";
import { classificationReviewRequired } from "../../../packages/protocol/src/finding-policy.js";

type ReviewableFinding =
  | Pick<Finding, "review_status" | "version" | "reviewed_version">
  | Pick<OverviewFinding, "review_status" | "reviewed">;

export type FindingReviewFilter = "all" | Finding["review_status"];

export const findingReviewLabels = {
  pending: "未审核",
  pass: "审核通过",
  needs_evidence: "待补证据",
  rejected: "已驳回",
} as const;

/** 修订后的旧审核结论只属于历史，当前版本重新归入未审核。 */
export function findingReviewStatus(finding: ReviewableFinding): Finding["review_status"] {
  if ("classification_review_required" in finding && finding.classification_review_required ||
    "evidence_ids" in finding && classificationReviewRequired(finding as Finding)) return "pending";
  const current = "reviewed" in finding
    ? finding.reviewed
    : finding.reviewed_version === finding.version;
  return current ? finding.review_status : "pending";
}

export function findingReviewOptions(findings: readonly ReviewableFinding[]) {
  const counts = { pending: 0, pass: 0, needs_evidence: 0, rejected: 0 };
  for (const finding of findings) counts[findingReviewStatus(finding)]++;
  return [
    ["all", `全部 ${findings.length}`],
    ...(["pending", "pass", "needs_evidence", "rejected"] as const).map(
      status => [status, `${findingReviewLabels[status]} ${counts[status]}`] as const,
    ),
  ] as const;
}
