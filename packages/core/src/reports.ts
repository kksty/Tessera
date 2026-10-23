import { reportMaterial, type Material } from "./report-material.js";
import { createHash, randomUUID } from "node:crypto";
import { Store, DomainError } from "./store.js";
import { digest } from "./execution.js";
import { zip } from "./zip.js";
import { relationLabels } from "../../protocol/src/graph-relations.js";
import { fence, inline, paragraph } from "./report-text.js";
import { reportView } from "./report-view.js";
import { missingReportFields } from "../../protocol/src/report-quality.js";

export interface ReportSnapshot {
  id: string;
  project_id: string;
  created_at: string;
  source_hash: string;
  format_version: 1;
  material: Material;
}
export class Reports {
  constructor(readonly store: Store) {
    store.db.exec("CREATE TABLE IF NOT EXISTS platform_reports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,data TEXT NOT NULL)");
  }
  private material(id: string): Material { return reportMaterial(this.store.get(id)); }

  create(id: string): ReportSnapshot {
    return this.store.transaction(() => {
      // Reports are derived data, but a project being deleted is locked: do not
      // create a snapshot that will outlive its project row.
      if (this.store.get(id).project.deletion)
        throw new DomainError(409, "项目正在删除，仅允许查看或重试删除");
      const material = this.material(id);
      const sourceHash = digest(material);
      const existing = this.store.db.prepare("SELECT data FROM platform_reports WHERE project_id=? AND json_extract(data,'$.source_hash')=? ORDER BY rowid DESC LIMIT 1").get(id, sourceHash);
      if (existing) return JSON.parse(String(existing.data)) as ReportSnapshot;
      const snapshot: ReportSnapshot = {
        id: `report_${randomUUID()}`, project_id: id, created_at: new Date().toISOString(),
        source_hash: sourceHash, format_version: 1, material,
      };
      this.store.db.prepare("INSERT INTO platform_reports VALUES(?,?,?)").run(snapshot.id, id, JSON.stringify(snapshot));
      this.store.audit(id, "report.created", { report: { id: snapshot.id, title: `生成报告快照 · ${material.findings.length} 项已确认漏洞` } });
      return snapshot;
    });
  }
  get(id: string, reportId: string): ReportSnapshot {
    this.store.get(id);
    const row = this.store.db.prepare("SELECT data FROM platform_reports WHERE project_id=? AND id=?").get(id, reportId);
    if (!row) throw new DomainError(404, "Report snapshot not found");
    return JSON.parse(String(row.data));
  }
  list(id: string) {
    const current = digest(this.material(id));
    return this.store.db.prepare("SELECT data FROM platform_reports WHERE project_id=? ORDER BY rowid DESC LIMIT 20").all(id)
      .map(row => {
        const r = JSON.parse(String(row.data)) as ReportSnapshot;
        return { id: r.id, created_at: r.created_at, source_hash: r.source_hash, stale: r.source_hash !== current,
          finding_count: r.material.findings.length, evidence_count: r.material.evidence.length,
          incomplete_count: r.material.findings.filter(finding => missingReportFields(finding).length).length };
      });
  }
  markdown(snapshot: ReportSnapshot): string {
    const v = reportView(snapshot.material);
    const lines = [
      `# ${inline(v.header.title)} · 安全评估报告`, "", `报告编号：${inline(snapshot.id)}`,
      `生成时间：${inline(snapshot.created_at)}`, `输入摘要（SHA-256）：${inline(snapshot.source_hash)}`, "",
      "## 目标与范围", "", `目标：${paragraph(v.header.goal)}`, "", `起点：${paragraph(v.header.origin)}`, "",
      ...v.scope.map(a => `- ${inline(a.hostname)}（${inline(a.id)}）`), "",
      "## 结果概览", "", `本报告包含 ${v.summary.total} 项当前版本已通过审核的漏洞。`,
      `未纳入正文：${v.summary.excluded.pending} 项待确认或待补证据，${v.summary.excluded.rejected} 项已驳回，${v.summary.excluded.informational} 项非漏洞信息类。`,
      `风险分布：${v.summary.bySeverity.map(level => `${level.label} ${level.count}`).join(" · ")}`, "",
      "风险等级未知时保持未知；无发现不等同于不存在漏洞。", "",
    ];
    if (!v.findings.length) lines.push(v.summary.empty, "");
    if (v.summary.incomplete) lines.push(`报告就绪度：${v.summary.incomplete} 项字段不全。`, "");
    for (const f of v.findings) {
      lines.push(`## ${inline(f.id)} · ${inline(f.title)}`, "", `版本：${f.version}；风险：${f.severityLabel}`);
      if (f.cvss) lines.push(inline(f.cvss.label));
      lines.push("", paragraph(f.description), "", "### 风险依据", "", paragraph(f.severityReason), "");
      if (f.cvss) lines.push(`CVSS 评分依据：${paragraph(f.cvss.rationale)}`, "");
      if (f.previousSeverityLabel !== undefined) lines.push(`复审前危险度（仅作历史标记）：${f.previousSeverityLabel}；最终危险度：${f.severityLabel}`, "");
      if (f.missing.length) lines.push(f.readiness, "");
      lines.push("### 实际影响", "", paragraph(f.impact), "",
        "### 复现条件", "", ...(f.conditions.length ? f.conditions.map(c => `- ${inline(c)}`) : ["未记录复现条件"]), "",
        "### 复现步骤", "");
      if (!f.reproBlocks.length) lines.push("缺少：复现步骤", "");
      f.reproBlocks.forEach((block, index) => {
        if (block.kind === "request") lines.push(`**${index + 1}. 请求**`, "", fence(block.text, "http"), "");
        else {
          const prefix = `${index + 1}. `;
          lines.push(prefix + paragraph(block.text).replace(/\n\n/g, "\n\n" + " ".repeat(prefix.length)), "");
        }
      });
      if (f.expected) lines.push(`正常预期：${paragraph(f.expected)}`, "");
      if (f.observed) lines.push(`实际观测：${paragraph(f.observed)}`, "");
      lines.push("### 修复建议", "", paragraph(f.remediation), "", "### 身份与证据", "",
        f.identity ? fence(f.identity, "json") : "漏洞身份未知", "",
        `来源事实：${inline(f.from.join("、") || "未记录")}`, `证据：${inline(f.evidenceIds.join("、") || "未记录")}`, "");
      if (f.evidence) lines.push(fence(f.evidence), "");
      for (const r of f.reviews) lines.push(`审核 ${inline(r.id)}：${paragraph(r.reason)}`, `审核证据：${inline(r.evidence_ids.join("、") || "未单列")}`, "");
      const trace = f.trace;
      for (const fact of trace.facts) lines.push(`来源 ${inline(fact.id)}${fact.status === "disputed" ? "（有争议）" : ""}：${paragraph(fact.description)}`, "");
      if (v.hasTrace) {
        lines.push("### 因果溯源", "");
        for (const step of trace.steps) lines.push(`任务 ${inline(step.id)}（输入 ${inline(step.from.join("、") || "未记录")}）：${paragraph(step.description)}`, "");
        for (const ref of trace.deleted_sources) lines.push(`来源 ${inline(ref.id)}：来源节点已删除；历史定位：${inline(ref.history_ref)}`, "");
        for (const edge of trace.relations) lines.push(`- ${inline(edge.source)} → ${inline(edge.target)}（${relationLabels[edge.kind]}${edge.run_id ? `；Run ${inline(edge.run_id)}` : ""}${edge.inferred ? "；历史关联，Run 未知" : ""}${edge.ambiguous ? "；生产来源有歧义" : ""}）`);
        lines.push("");
      }
    }
    lines.push("## 原始证据索引", "");
    for (const e of v.evidence) lines.push(`- ${inline(e.id)}：${inline(e.title)}；${e.size} 字节；${inline(e.mime_type)}；SHA-256：${inline(e.sha256)}`);
    lines.push("", "本报告为固定内容快照；后续 Finding、审核、范围或证据引用变更后，旧快照会标记过期。", "");
    return lines.join("\n");
  }
  archive(snapshot: ReportSnapshot): Buffer {
    const files = [{ name: "report.md", bytes: Buffer.from(this.markdown(snapshot)) },
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(snapshot, null, 2)) }];
    let size = files.reduce((n, f) => n + f.bytes.length, 0);
    if (snapshot.material.evidence.length > 2000) throw new DomainError(413, "Report has too many evidence files");
    const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/json": "json", "text/plain": "txt", "text/html": "html" };
    for (const evidence of snapshot.material.evidence) {
      if (size + evidence.size > 64 * 1024 * 1024) throw new DomainError(413, "Evidence archive exceeds 64 MiB");
      const { bytes } = this.store.evidenceContent(snapshot.project_id, evidence.id);
      if (bytes.length !== evidence.size || createHash("sha256").update(bytes).digest("hex") !== evidence.sha256)
        throw new DomainError(409, `Archived evidence integrity changed: ${evidence.id}`);
      files.push({ name: `evidence/${evidence.id}.${extensions[evidence.mime_type] || "bin"}`, bytes });
      size += bytes.length;
    }
    return zip(files);
  }
}
