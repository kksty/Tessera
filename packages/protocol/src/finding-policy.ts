import type { Finding, Graph } from "./models.js";
import { scoreCvss, severityFromScore, validateImpactEvidence } from "./cvss.js";

export type FindingKind = "vulnerability" | "informational";

/** Validate persisted ratings too: an old pass or a model-supplied score is insufficient. */
export function validVulnerabilityRating(finding: Finding): boolean {
  const rating = finding.cvss;
  if (!rating || rating.version !== "4.0" || !rating.rationale?.trim()) return false;
  try {
    const computed = scoreCvss(rating);
    validateImpactEvidence(computed, finding.evidence_ids);
    return computed.score > 0 && computed.score === rating.score &&
      finding.severity === severityFromScore(computed.score);
  } catch { return false; }
}

/** Classification is explicit; a rating never supplies a missing classification. */
export function findingKind(finding: Finding): FindingKind | null {
  return finding.kind ?? null;
}

const currentPass = (finding: Finding) => !finding.deleted && !finding.merged_into && !finding.withdrawn_at &&
  finding.status !== "rejected" && finding.review_status === "pass" && finding.reviewed_version === finding.version;

export const informationalFinding = (finding: Finding) => findingKind(finding) === "informational";

/** One pure contract for server totals, exports, reports and browser filters. */
export function confirmedFinding(finding: Finding, graph?: Pick<Graph, "evidence">): boolean {
  if (!currentPass(finding) || !finding.evidence_ids.length ||
    graph && finding.evidence_ids.some(id => !graph.evidence.some(e => e.id === id))) return false;
  const kind = findingKind(finding);
  return kind === "informational" && finding.severity == null && finding.cvss == null ||
    kind === "vulnerability" && validVulnerabilityRating(finding);
}
export const confirmedVulnerability = (finding: Finding, graph?: Pick<Graph, "evidence">) =>
  findingKind(finding) === "vulnerability" && confirmedFinding(finding, graph);
export const confirmedInformational = (finding: Finding, graph?: Pick<Graph, "evidence">) =>
  informationalFinding(finding) && confirmedFinding(finding, graph);
export const classificationReviewRequired = (finding: Finding, graph?: Pick<Graph, "evidence">) =>
  currentPass(finding) && !confirmedFinding(finding, graph);
export const currentCvssScore = (finding: Finding, graph?: Pick<Graph, "evidence">): number | null =>
  confirmedVulnerability(finding, graph) ? finding.cvss!.score : null;
