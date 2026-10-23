import type { CvssInput, ImpactEvidence } from "../../packages/core/src/cvss.js";

export function withImpactEvidence(input: CvssInput, evidenceIds = ["e001"]): CvssInput {
  const impact_evidence = input.vector.split("/").flatMap(part => {
    const [metric, value] = part.split(":");
    if (!["VC", "VI", "VA", "SC", "SI", "SA"].includes(metric) || value === "N") return [];
    return [{ metric: metric as ImpactEvidence["metric"], affected: "受保护的测试资源",
      boundary: "未授权主体不能读取、修改或阻断该资源",
      consequence: "原始证据记录了越过权限边界后对该资源的影响", evidence_ids: evidenceIds }];
  });
  return { ...input, impact_evidence };
}

/** CVSS v4.0 vectors from the specification corpus, reused by review tests. */
const vectors = {
  critical: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", rationale: "Unauthenticated high-impact issue" },
  high: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H", rationale: "Remote high-impact issue" },
  medium: { vector: "CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L", rationale: "Local medium-impact issue" },
  low: { vector: "CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", rationale: "Limited-impact issue" },
  none: { vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N", rationale: "No impact" },
} as const;
export const cvss = Object.fromEntries(Object.entries(vectors).map(([key, value]) => [key, withImpactEvidence(value)])) as {
  [K in keyof typeof vectors]: CvssInput
};
