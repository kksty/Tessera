import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ReportSnapshot } from "../../../../packages/core/src/reports.js";
import { reportView } from "../../../../packages/core/src/report-view.js";
import { prose, type ReproBlock } from "../../../../packages/core/src/report-text.js";
import { relationLabels } from "../../../../packages/protocol/src/graph-relations.js";
import { Badge, Modal } from "./ui.js";
import { path } from "../api.js";

function ReproRequest({ text, index }: { text: string; index: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 非安全上下文没有剪贴板权限时保持静默，代码仍可手动选择。 */
    }
  };
  return (
    <figure className="repro-request" role="listitem">
      <figcaption>
        <span className="repro-step-num">{index}</span>
        <span className="repro-request-label">请求</span>
        <span className="spacer" />
        <button type="button" className="repro-copy" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </figcaption>
      <pre><code>{text}</code></pre>
    </figure>
  );
}

function ReproSteps({ blocks }: { blocks: ReproBlock[] }) {
  return (
    <div className="repro-steps" role="list">
      {blocks.map((block, index) =>
        block.kind === "request" ? (
          <ReproRequest key={`request-${index}`} text={block.text} index={index + 1} />
        ) : (
          <div className="repro-step" role="listitem" key={`step-${index}`}>
            <span className="repro-step-num">{index + 1}</span>
            <p>{block.text}</p>
          </div>
        ),
      )}
    </div>
  );
}

export function ReportPreview({ report, stale, onClose }: { report: ReportSnapshot; stale: boolean; onClose: () => void }) {
  return <Modal
    label="报告网页预览"
    title={`${reportView(report.material).header.title} · 安全评估报告`}
    onClose={onClose}
    className="report-modal"
    width={1080}
  ><ReportContent report={report} stale={stale} /></Modal>;
}

export function ReportContent({ report, stale }: { report: ReportSnapshot; stale: boolean }) {
  const v = reportView(report.material);
  return <div className="report-preview">
      <p className="quiet">{report.created_at} · 固定版本快照</p>
      <p className={stale ? "evidence-note" : "quiet"}>{stale ? "项目输入已变化，以下为生成时的内容。" : "当前快照"}</p>
      <div className="report-actions"><a className="button" href={"/api" + path(report.project_id, `/reports/${report.id}/content?format=markdown`)}>下载 Markdown</a><a className="button" href={"/api" + path(report.project_id, `/reports/${report.id}/content?format=zip`)}>下载报告与证据</a></div>
      <h3>目标与范围</h3><p className="report-prose">{v.header.goal}</p><p className="quiet report-prose">起点：{v.header.origin}</p>
      <ul>{v.scope.map(a => <li key={a.id}>{a.hostname}（{a.id}）</li>)}</ul>
      <h3>风险概况</h3>
      <div className="report-risks">{v.summary.bySeverity.map(level => <span key={level.key}>{level.label} <strong>{level.count}</strong></span>)}</div>
      <p>本报告包含 {v.summary.total} 项当前版本已通过审核的漏洞。未纳入正文：待确认 {v.summary.excluded.pending} 项、驳回 {v.summary.excluded.rejected} 项、非漏洞信息类 {v.summary.excluded.informational} 项。</p>
      <p className="quiet">风险等级未知时保持未知；无发现不等同于不存在漏洞。</p>
      {!v.findings.length && <p className="quiet">{v.summary.empty}</p>}
      {!!v.summary.incomplete && <p className="evidence-note">报告就绪度：{v.summary.incomplete} 项字段不全。</p>}
      {v.findings.map(f => <article className="report-finding" key={f.id}>
        <h3>{f.id} · {f.title}</h3><p><Badge value={f.severityLabel} /> · 版本 {f.version}{f.cvss && <> · CVSS v4.0：{f.cvss.score.toFixed(1)}</>}</p>
        {f.cvss && <p className="mono">{f.cvss.label}</p>}
        <p className="report-prose">{f.description}</p>
        <h4>风险依据</h4><p className="report-prose">{f.severityReason}</p>
        {f.cvss && <p className="report-prose">CVSS 评分依据：{prose(f.cvss.rationale)}</p>}
        {f.previousSeverityLabel !== undefined && <p className="quiet">复审前危险度（仅作历史标记）：{f.previousSeverityLabel}；最终危险度：{f.severityLabel}</p>}
        {!!f.missing.length && <p className="evidence-note">{f.readiness}</p>}
        <h4>实际影响</h4><p className="report-prose">{f.impact}</p>
        <h4>复现条件</h4>{f.conditions.length ? <ul>{f.conditions.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p>未记录复现条件</p>}
        <h4>复现步骤</h4>{f.reproBlocks.length ? <ReproSteps blocks={f.reproBlocks} /> : <p>缺少：复现步骤</p>}
        {f.expected && <p className="report-prose">正常预期：{f.expected}</p>}{f.observed && <p className="report-prose">实际观测：{f.observed}</p>}
        <h4>修复建议</h4><p className="report-prose">{f.remediation}</p>
        <h4>身份与证据</h4>{f.identity ? <pre className="report-code"><code>{f.identity}</code></pre> : <p>漏洞身份未知</p>}
        <p>来源事实：{f.from.join("、") || "未记录"}</p><p>证据：{f.evidenceIds.join("、") || "未记录"}</p>{f.evidence && <pre className="report-code"><code>{f.evidence}</code></pre>}
        {f.reviews.map(r => <p className="report-prose" key={r.id}>审核 {r.id}：{prose(r.reason)}（证据：{r.evidence_ids.join("、") || "未单列"}）</p>)}
        {f.trace.facts.map(fact => <p className="quiet report-prose" key={fact.id}>来源 {fact.id}{fact.status === "disputed" ? "（有争议）" : ""}：{prose(fact.description)}</p>)}
        {v.hasTrace && <details><summary>因果溯源</summary>
          {f.trace.deleted_sources.map(ref => <p className="quiet" key={ref.id}>{ref.id}：来源节点已删除 · <a href={"/api" + ref.history_ref} target="_blank" rel="noreferrer">读取历史</a></p>)}
          {f.trace.steps.map(step => <p className="report-prose" key={step.id}>任务 {step.id}（输入 {step.from.join("、") || "未记录"}）：{prose(step.description)}</p>)}
          {f.trace.relations.map(edge => <p className="quiet" key={`${edge.kind}:${edge.source}:${edge.target}`}>
            {edge.source} → {edge.target}（{relationLabels[edge.kind]}{edge.run_id ? `；Run ${edge.run_id}` : ""}{edge.inferred ? "；历史关联，Run 未知" : ""}{edge.ambiguous ? "；生产来源有歧义" : ""}）
          </p>)}
        </details>}
      </article>)}
      <h3>原始证据索引</h3>{v.evidence.map(e => <article key={e.id}><p>{e.id} · {e.title} · {e.size} 字节</p><p className="quiet">{e.mime_type} · SHA-256：{e.sha256}</p><a href={"/api" + path(report.project_id, `/evidence/${e.id}/content`)} target="_blank" rel="noreferrer">查看原始证据</a></article>)}
      <p className="quiet">本报告为固定内容快照；后续 Finding、审核、范围或证据引用变更后，旧快照会标记过期。</p>
      <details><summary>快照标识</summary><p>{report.id}</p><p>SHA-256：{report.source_hash}</p></details>
    </div>;
}
