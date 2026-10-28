import type { Finding } from "../../../packages/protocol/src/index.js";
import { severityLabels } from "./format.js";
import { findingKind } from "../../../packages/protocol/src/finding-policy.js";

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

const identityLabels: [keyof NonNullable<Finding["identity"]>, string][] = [
  ["category", "类别"],
  ["host", "主机"],
  ["port", "端口"],
  ["protocol", "协议"],
  ["method", "请求方法"],
  ["path", "请求路径"],
  ["location", "其他入口"],
  ["parameter", "参数"],
  ["source_role", "操作身份"],
  ["target_role", "受影响身份"],
  ["variant", "状态或变体"],
];

/**
 * 把一个发现的完整描述整理成可直接粘贴的纯文本（Markdown 风格的小标题）。
 * 只收单个漏洞：标题、危险度、描述、影响、复现、修复、身份与证据，
 * 便于把这一条漏洞整体复制到工单、聊天或文档里。
 */
export function findingCopyText(finding: Finding): string {
  const out: string[] = [];
  const title = text(finding.title) || finding.id;
  out.push(`# ${finding.id} · ${title}`);

  const meta: string[] = [];
  const kind = findingKind(finding);
  meta.push(kind === "informational" ? "信息类" : kind === "vulnerability" ? "漏洞类" : "待分类");
  if (finding.severity) meta.push(`危险度：${severityLabels[finding.severity] || finding.severity}`);
  else if (kind !== "informational") meta.push("危险度：未定级");
  meta.push(`版本 v${finding.version}`);
  if (finding.cvss?.score != null)
    meta.push(`CVSS ${finding.cvss.score.toFixed(1)}${finding.cvss.vector ? `（${finding.cvss.vector}）` : ""}`);
  out.push(meta.join(" · "));

  const description = text(finding.description);
  if (description) out.push("", "## 漏洞描述", description);

  const reason = text(finding.severity_reason);
  if (reason) out.push("", "## 风险依据", reason);

  const impact = text(finding.impact);
  if (impact) out.push("", "## 实际影响", impact);

  const conditions = (finding.reproduction?.conditions || []).map((line) => line.trim()).filter(Boolean);
  const steps = (finding.reproduction?.steps || []).map((line) => line.trim()).filter(Boolean);
  if (
    conditions.length ||
    steps.length ||
    text(finding.reproduction?.expected) ||
    text(finding.reproduction?.observed)
  ) {
    out.push("", "## 复现与验证");
    if (conditions.length) {
      out.push("", "前置条件：");
      conditions.forEach((line) => out.push(`- ${line}`));
    }
    if (steps.length) {
      out.push("", "复现步骤：");
      steps.forEach((line, index) => out.push(`${index + 1}. ${line}`));
    }
    if (text(finding.reproduction?.expected)) out.push("", `正常预期：${text(finding.reproduction?.expected)}`);
    if (text(finding.reproduction?.observed)) out.push("", `实际观测：${text(finding.reproduction?.observed)}`);
  }

  const remediation = text(finding.remediation);
  if (remediation) out.push("", "## 修复建议", remediation);

  if (finding.identity) {
    const rows = identityLabels
      .map(([key, label]) => [label, text(finding.identity?.[key])] as const)
      .filter(([, value]) => value);
    if (rows.length) {
      out.push("", "## 目标与入口");
      rows.forEach(([label, value]) => out.push(`${label}：${value}`));
    }
  }

  if (finding.evidence_ids?.length || text(finding.evidence)) {
    out.push("", "## 证据");
    if (finding.evidence_ids?.length) out.push(`证据引用：${finding.evidence_ids.join("、")}`);
    if (text(finding.evidence)) out.push("", text(finding.evidence));
  }

  return out.join("\n");
}
