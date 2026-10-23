import type { Finding, Review } from "../../../packages/protocol/src/index.js";

/** A historical verdict describes its submitted text, never the latest rewritten title. */
export function reviewedFindingSnapshot(finding: Finding | undefined, review: Review) {
  if (!finding) return undefined;
  if (finding.version === review.finding_version) return finding;
  return finding.edits?.find(edit => edit.version === review.finding_version)?.previous;
}

export function reviewVersionLabel(review: Review) {
  return `发现 ${review.finding_id} · 第 ${review.finding_version} 版`;
}
