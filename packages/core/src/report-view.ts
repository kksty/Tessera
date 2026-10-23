import { findingTrace, type Material } from "./report-material.js";
import { prose, reproductionBlocks } from "./report-text.js";
import { missingReportFields, reportFieldLabels } from "../../protocol/src/report-quality.js";

export const reportSeverities = [
  { key: "critical", label: "严重" }, { key: "high", label: "高" },
  { key: "medium", label: "中" }, { key: "low", label: "低" },
  { key: "informational", label: "信息" }, { key: "unknown", label: "未定级" },
];
const severityLabel = (value: string | null | undefined) => reportSeverities.find(level => level.key === value)?.label ?? "未定级";
const field = (value: string | null | undefined, fallback: string) => prose(value || "") || fallback;

/** Derived only: presentation changes must not change reportMaterial or source_hash. */
export function reportView(material: Material) {
  const findings = [...material.findings].sort((a, b) => (b.cvss?.score ?? -1) - (a.cvss?.score ?? -1) || a.id.localeCompare(b.id))
    .map(finding => {
      const missing = missingReportFields(finding);
      return {
        id: finding.id, title: prose(finding.title).replace(/\n/g, " "), version: finding.version,
        severity: finding.severity, severityLabel: severityLabel(finding.severity),
        previousSeverityLabel: finding.severity_before_review !== undefined ? severityLabel(finding.severity_before_review) : undefined,
        cvss: finding.cvss ? { ...finding.cvss, label: `CVSS v4.0：${finding.cvss.score.toFixed(1)} · ${finding.cvss.vector}` } : null,
        description: field(finding.description, "缺少：漏洞描述"),
        severityReason: field(finding.severity_reason, "未记录"),
        impact: field(finding.impact, "缺少：影响描述"),
        conditions: finding.reproduction?.conditions.map(prose).filter(Boolean) ?? [],
        reproBlocks: reproductionBlocks(finding.reproduction?.steps ?? []),
        expected: field(finding.reproduction?.expected, ""), observed: field(finding.reproduction?.observed, ""),
        remediation: field(finding.remediation, "缺少：修复建议"),
        identity: finding.identity ? JSON.stringify(finding.identity, null, 2) : null,
        from: finding.from, evidenceIds: finding.evidence_ids, evidence: finding.evidence,
        reviews: material.reviews.filter(review => review.finding_id === finding.id),
        trace: findingTrace(material, finding.id),
        missing, readiness: missing.length ? `缺少：${missing.map(key => reportFieldLabels[key]).join(" / ")}` : "报告字段完整",
      };
    });
  return {
    header: { ...material.project, title: prose(material.project.title).replace(/\n/g, " "), goal: prose(material.goal), origin: prose(material.origin) },
    scope: material.scope,
    summary: {
      total: findings.length, excluded: material.excluded,
      bySeverity: reportSeverities.map(level => ({ ...level, count: findings.filter(f => (f.severity || "unknown") === level.key).length })),
      incomplete: findings.filter(finding => finding.missing.length).length,
      empty: "此快照没有符合纳入条件的漏洞。无发现不等同于不存在漏洞。",
    },
    findings, evidence: material.evidence, hasTrace: !!(material.trace.relations.length || material.trace.steps.length || material.trace.deleted_sources?.length),
  };
}
