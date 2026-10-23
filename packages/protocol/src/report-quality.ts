import type { Finding } from "./models.js";

export const reportFieldLabels = {
  impact: "影响描述",
  "reproduction.steps": "复现步骤",
  remediation: "修复建议",
} as const;

/** Shared by new confirmations and presentation; never added to frozen material. */
export function missingReportFields(finding: Pick<Finding, "impact" | "reproduction" | "remediation">) {
  const missing: (keyof typeof reportFieldLabels)[] = [];
  if (!finding.impact?.trim()) missing.push("impact");
  if (!finding.reproduction?.steps.some(step => step.trim())) missing.push("reproduction.steps");
  if (!finding.remediation?.trim()) missing.push("remediation");
  return missing;
}
