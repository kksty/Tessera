import { useState, type ReactNode } from "react";
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import type { ReportSnapshot } from "../../../../packages/core/src/reports.js";
import { reportView } from "../../../../packages/core/src/report-view.js";
import { prose, type ReproBlock } from "../../../../packages/core/src/report-text.js";
import { relationLabels } from "../../../../packages/protocol/src/graph-relations.js";
import { SeverityBadge } from "./ui.js";
import { Modal } from "./ui.js";
import { RichText } from "./RichText.js";
import { path } from "../api.js";

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
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
    <button type="button" className="report-copy" onClick={() => void copy()}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "已复制" : label}
    </button>
  );
}

function ReproRequest({ text, index }: { text: string; index: number }) {
  return (
    <figure className="repro-request" role="listitem">
      <figcaption>
        <span className="repro-step-num">{index}</span>
        <span className="repro-request-label">请求</span>
        <span className="spacer" />
        <CopyButton text={text} />
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
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

/** 一致性小标题：无内容时整段省略，避免空壳。 */
function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="report-block">
      <header className="report-block-head">
        <h4>{title}</h4>
        {note ? <span className="report-block-note">{note}</span> : null}
      </header>
      {children}
    </section>
  );
}

function CvssBox({
  cvss,
}: {
  cvss: {
    version: string;
    vector: string;
    score: number;
    rationale?: string | null;
    impact_evidence?: readonly {
      metric: string;
      affected: string;
      boundary?: string;
      consequence?: string;
      evidence_ids?: readonly string[] | string;
    }[];
  };
}) {
  return (
    <Section
      title={`CVSS v${cvss.version || "4.0"} 评分`}
      note={<strong className="report-cvss-score">{cvss.score.toFixed(1)}</strong>}
    >
      <div className="report-cvss-vector">
        <code>{cvss.vector}</code>
        <CopyButton text={cvss.vector} label="复制向量" />
      </div>
      {prose(cvss.rationale || "") && <RichText text={cvss.rationale} />}
      {!!cvss.impact_evidence?.length && (
        <table className="report-cvss-table">
          <thead>
            <tr>
              <th>指标</th>
              <th>受影响对象</th>
              <th>边界 / 依据</th>
              <th>后果</th>
              <th>证据</th>
            </tr>
          </thead>
          <tbody>
            {cvss.impact_evidence.map((row, index) => (
              <tr key={`${row.metric}-${index}`}>
                <td className="mono">{row.metric}</td>
                <td>{prose(row.affected)}</td>
                <td>{prose(row.boundary || "") || "—"}</td>
                <td>{prose(row.consequence || "") || "—"}</td>
                <td className="mono">
                  {Array.isArray(row.evidence_ids) ? row.evidence_ids.join(" ") : row.evidence_ids || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export function ReportPreview({
  report,
  stale,
  onClose,
}: {
  report: ReportSnapshot;
  stale: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      label="报告网页预览"
      title={`${reportView(report.material).header.title} · 安全评估报告`}
      onClose={onClose}
      className="report-modal"
      width={1080}
    >
      <ReportContent report={report} stale={stale} />
    </Modal>
  );
}

export function ReportContent({ report, stale }: { report: ReportSnapshot; stale: boolean }) {
  const v = reportView(report.material);
  return (
    <div className="report-preview">
      <section className="report-cover">
        <p className="report-cover-title">{v.header.title}</p>
        <p className="report-cover-sub">安全评估报告</p>
        <dl className="report-cover-meta">
          <div>
            <dt>报告编号</dt>
            <dd className="mono">{report.id}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{report.created_at}</dd>
          </div>
          <div>
            <dt>输入摘要</dt>
            <dd className="mono report-hash">{report.source_hash}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd className={stale ? "report-stale" : "report-current"}>
              {stale ? "输入已变化，以下为生成时的固定快照" : "当前快照"}
            </dd>
          </div>
        </dl>
        <div className="report-actions">
          <a
            className="button small"
            href={"/api" + path(report.project_id, `/reports/${report.id}/content?format=markdown`)}
          >
            <Download size={12} aria-hidden="true" />
            下载 Markdown
          </a>
          <a
            className="button small"
            href={"/api" + path(report.project_id, `/reports/${report.id}/content?format=zip`)}
          >
            <Download size={12} aria-hidden="true" />
            下载报告与证据
          </a>
        </div>
      </section>

      <Section title="目标与范围">
        <p className="report-prose">{v.header.goal || "（未记录目标）"}</p>
        <p className="report-kv">
          <span>起点</span>
          <span>{v.header.origin || "（未记录起点）"}</span>
        </p>
        {v.scope.length ? (
          <ul className="report-scope">
            {v.scope.map((a) => (
              <li key={a.id}>
                <span className="mono">{a.hostname}</span>
                <span className="quiet">{a.id}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">未记录已批准的范围资产。</p>
        )}
      </Section>

      <Section title="结果概览">
        <div className="report-risks">
          {v.summary.bySeverity.map((level) => (
            <span key={level.key} data-severity={level.key}>
              {level.label} <strong>{level.count}</strong>
            </span>
          ))}
        </div>
        <p>
          本报告包含 <strong>{v.summary.total}</strong> 项当前版本已通过审核的漏洞。未纳入正文：待确认{" "}
          {v.summary.excluded.pending} 项、驳回 {v.summary.excluded.rejected} 项、非漏洞信息类{" "}
          {v.summary.excluded.informational} 项。
        </p>
        <p className="quiet">风险等级未知时保持未知；无发现不等同于不存在漏洞。</p>
        {!!v.summary.incomplete && <p className="evidence-note">报告就绪度：{v.summary.incomplete} 项字段不全。</p>}
      </Section>

      <h3 className="report-findings-heading">漏洞详情（{v.findings.length} 项）</h3>
      {!v.findings.length && <p className="quiet">{v.summary.empty}</p>}

      {v.findings.map((f, index) => (
        <article className="report-finding" key={f.id}>
          <header className="report-finding-head">
            <span className="report-finding-index">{index + 1}</span>
            <div className="report-finding-title">
              <h3>
                {f.id} · {f.title}
              </h3>
              <div className="report-finding-meta">
                <SeverityBadge severity={f.severity} />
                <span>版本 v{f.version}</span>
                {f.cvss && <span className="mono">CVSS {f.cvss.score.toFixed(1)}</span>}
                {f.previousSeverityLabel !== undefined && (
                  <span className="quiet">复审前 {f.previousSeverityLabel}</span>
                )}
              </div>
            </div>
          </header>

          {!!f.missing.length && <p className="evidence-note">{f.readiness}</p>}

          <Section title="漏洞描述">
            <RichText text={f.description} />
          </Section>

          <Section title="风险依据">
            <RichText text={f.severityReason} />
          </Section>

          {f.cvss && <CvssBox cvss={f.cvss} />}

          <Section title="实际影响">
            <RichText text={f.impact} />
          </Section>

          <Section title="修复建议">
            <RichText text={f.remediation} />
          </Section>

          {/* 复现与验证紧跟修复建议，作为一整块，方便整段复制。 */}
          <Section title="复现与验证">
            <div className="report-repro-group">
              <div className="report-repro-sub">
                <h5>复现条件</h5>
                {f.conditions.length ? (
                  <ul className="report-list">
                    {f.conditions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="quiet">未记录复现条件</p>
                )}
              </div>

              <div className="report-repro-sub">
                <h5>复现步骤{f.reproBlocks.length ? `（${f.reproBlocks.length} 步）` : ""}</h5>
                {f.reproBlocks.length ? <ReproSteps blocks={f.reproBlocks} /> : <p className="quiet">缺少：复现步骤</p>}
              </div>

              {(f.expected || f.observed) && (
                <div className="report-compare">
                  {f.expected && (
                    <div>
                      <h5>正常预期</h5>
                      <RichText text={f.expected} />
                    </div>
                  )}
                  {f.observed && (
                    <div>
                      <h5>实际观测</h5>
                      <RichText text={f.observed} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Section>

          <Section title="身份与证据">
            {f.identity ? (
              <pre className="report-code">
                <code>{f.identity}</code>
              </pre>
            ) : (
              <p className="quiet">漏洞身份未知</p>
            )}
            <p className="report-kv">
              <span>来源事实</span>
              <span className="mono">{f.from.join("、") || "未记录"}</span>
            </p>
            <p className="report-kv">
              <span>证据</span>
              <span className="mono">{f.evidenceIds.join("、") || "未记录"}</span>
            </p>
            {f.evidence && (
              <details className="report-details">
                <summary>证据原文</summary>
                <pre className="report-code">
                  <code>{f.evidence}</code>
                </pre>
              </details>
            )}
          </Section>

          {!!f.reviews.length && (
            <Section title="审核记录">
              {f.reviews.map((r) => (
                <div className="report-review" key={r.id}>
                  <p className="report-review-id">
                    <strong>{r.id}</strong>
                  </p>
                  <RichText text={r.reason} />
                  <p className="quiet">审核证据：{r.evidence_ids.join("、") || "未单列"}</p>
                </div>
              ))}
            </Section>
          )}

          {!!f.trace.facts.length && (
            <Section title="来源事实">
              {f.trace.facts.map((fact) => (
                <div className="report-fact" key={fact.id}>
                  <p className="report-fact-head quiet">
                    来源 {fact.id}
                    {fact.status === "disputed" ? "（有争议）" : ""}
                  </p>
                  <RichText text={fact.description} />
                </div>
              ))}
            </Section>
          )}

          {v.hasTrace && (
            <details className="report-details report-trace">
              <summary>因果溯源</summary>
              {f.trace.deleted_sources.map((ref) => (
                <p className="quiet" key={ref.id}>
                  {ref.id}：来源节点已删除 ·{" "}
                  <a href={"/api" + ref.history_ref} target="_blank" rel="noreferrer">
                    读取历史
                  </a>
                </p>
              ))}
              {f.trace.steps.map((step) => (
                <div className="report-trace-step" key={step.id}>
                  <p className="report-fact-head">
                    任务 {step.id}（输入 {step.from.join("、") || "未记录"}）
                  </p>
                  <RichText text={step.description} />
                </div>
              ))}
              {f.trace.relations.map((edge) => (
                <p className="quiet" key={`${edge.kind}:${edge.source}:${edge.target}`}>
                  {edge.source} → {edge.target}（{relationLabels[edge.kind]}
                  {edge.run_id ? `；Run ${edge.run_id}` : ""}
                  {edge.inferred ? "；历史关联，Run 未知" : ""}
                  {edge.ambiguous ? "；生产来源有歧义" : ""}）
                </p>
              ))}
            </details>
          )}
        </article>
      ))}

      <Section title="原始证据索引" note={`${v.evidence.length} 份`}>
        {v.evidence.length ? (
          <ul className="report-evidence">
            {v.evidence.map((e) => (
              <li key={e.id}>
                <div className="report-evidence-main">
                  <span className="mono">{e.id}</span>
                  <span>{e.title}</span>
                  <span className="quiet">{e.size} 字节</span>
                </div>
                <div className="report-evidence-meta">
                  <span className="quiet">{e.mime_type}</span>
                  <span className="mono quiet report-hash">{e.sha256}</span>
                  <a
                    className="report-evidence-link"
                    href={"/api" + path(report.project_id, `/evidence/${e.id}/content`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看原始证据
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">无证据文件。</p>
        )}
      </Section>

      <footer className="report-footer">
        <p className="quiet">本报告为固定内容快照；后续 Finding、审核、范围或证据引用变更后，旧快照会标记过期。</p>
        <details className="report-details">
          <summary>快照标识</summary>
          <p className="mono">{report.id}</p>
          <p className="mono report-hash">SHA-256：{report.source_hash}</p>
        </details>
      </footer>
    </div>
  );
}
