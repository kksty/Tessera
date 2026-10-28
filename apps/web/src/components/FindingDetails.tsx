import { useEffect, useRef, useState } from "react";
import type { Finding } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { fmt, locateRecord, useWorkspace } from "../workspace.js";
import { SeverityBadge as UiSeverityBadge } from "./ui.js";
import { reviewTone, severityLabels } from "../format.js";
import { findingReviewLabels, findingReviewStatus } from "../finding-review.js";
import { InlineText, RichText, splitLead } from "./RichText.js";
import { prettyText } from "../text.js";
import { GraphReference } from "./NodeHistory.js";
import { FindingActions } from "./FindingActions.js";
import { FindingTrafficPanel, hasHttpTrafficHint } from "./FindingTraffic.js";
import {
  findingKind,
  confirmedVulnerability,
  classificationReviewRequired,
  informationalReviewExempt,
} from "../../../../packages/protocol/src/finding-policy.js";

export const severityLabelMap: Record<string, string> = severityLabels;
const labels = severityLabels;

/** 兼容旧调用：危险度标签。 */
export const SeverityBadge = ({ severity, label }: { severity?: Finding["severity"]; label?: string }) => (
  <UiSeverityBadge severity={severity} prefix={label} />
);

type Draft = {
  base: number;
  kind: string;
  severity: string;
  reason: string;
  impact: string;
  remediation: string;
  conditions: string;
  steps: string;
  expected: string;
  observed: string;
  identity: Record<string, string>;
};

const fromFinding = (f: Finding): Draft => ({
  base: f.version,
  kind: findingKind(f) || "",
  severity: f.severity || "",
  reason: f.severity_reason || "",
  impact: f.impact || "",
  remediation: f.remediation || "",
  conditions: (f.reproduction?.conditions || []).join("\n"),
  steps: (f.reproduction?.steps || []).join("\n"),
  expected: f.reproduction?.expected || "",
  observed: f.reproduction?.observed || "",
  identity: Object.fromEntries(Object.entries(f.identity || {}).map(([key, value]) => [key, String(value)])),
});

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());

const identityFields = [
  ["category", "漏洞类别"],
  ["host", "目标主机"],
  ["protocol", "协议"],
  ["port", "端口"],
  ["method", "请求方法"],
  ["path", "请求路径"],
  ["location", "其他入口位置"],
  ["parameter", "参数"],
  ["source_role", "操作身份"],
  ["target_role", "受影响身份"],
  ["variant", "状态或变体"],
] as const;

export function FindingDetails({
  finding: f,
  allowActions = false,
  editSignal = 0,
}: {
  finding: Finding;
  allowActions?: boolean;
  editSignal?: number;
}) {
  const ws = useWorkspace();
  const key = `tessera.findingDraft:${ws.id}:${f.id}`;
  const load = (): Draft | null => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(key) || "null");
      return draft && typeof draft.base === "number" && draft.identity ? draft : null;
    } catch {
      return null;
    }
  };
  const [draft, setDraft] = useState<Draft>(() => load() || fromFinding(f));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editing) {
      sessionStorage.setItem(key, JSON.stringify(draft));
    }
  }, [draft, editing, key]);
  // 页头的「修订」通过递增信号点进来（FindingDetails 以 finding.id 为 key，故每次都是同一实例）。
  const lastSignal = useRef(editSignal);
  useEffect(() => {
    if (editSignal === lastSignal.current) return;
    lastSignal.current = editSignal;
    setDraft(load() || fromFinding(f));
    setEditing(true);
  }, [editSignal, f.status, f.version]);
  const update = (field: keyof Draft, value: string) => setDraft((d) => ({ ...d, [field]: value }));
  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  async function submit() {
    const ok = await ws.action(async () => {
      const entries = Object.entries(draft.identity)
        .filter(([, value]) => value.trim())
        .map(([name, value]) => [name, value.trim()]);
      const identity: Record<string, string | number> | null = entries.length ? Object.fromEntries(entries) : null;
      if (identity && (!identity.category || !identity.host || !(identity.path || identity.location)))
        throw new Error("漏洞身份需包含类别、目标和入口位置，未知可留空。");
      if (identity?.port) {
        const port = Number(identity.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口需要是 1–65535 的整数。");
        identity.port = port;
      }
      await api(
        path(ws.id!, `/findings/${f.id}/details`),
        {
          expected_version: draft.base,
          kind: draft.kind || null,
          severity: draft.kind === "informational" ? null : draft.severity || null,
          severity_reason: draft.reason.trim() || null,
          impact: draft.impact.trim() || null,
          remediation: draft.remediation.trim() || null,
          identity,
          reproduction:
            lines(draft.conditions).length ||
            lines(draft.steps).length ||
            draft.expected.trim() ||
            draft.observed.trim()
              ? {
                  conditions: lines(draft.conditions),
                  steps: lines(draft.steps),
                  ...(draft.expected.trim() ? { expected: draft.expected.trim() } : {}),
                  ...(draft.observed.trim() ? { observed: draft.observed.trim() } : {}),
                }
              : null,
        },
        "PUT",
      );
    });
    if (ok) {
      setEditing(false);
      sessionStorage.removeItem(key);
    }
  }

  if (editing)
    return (
      <section className="finding-editor" aria-label="修订发现草稿">
        <div className="fd-editor-note">
          <strong>修订草稿</strong>
          <span>自动保存在当前浏览器标签页，尚未提交审核。</span>
        </div>
        {draft.base !== f.version && (
          <div className="banner warn">
            <span>
              <strong>发现已更新至 v{f.version}</strong> · 草稿基于 v{draft.base}，已保留全部编辑内容。
            </span>
            <button type="button" className="button small" onClick={() => setDraft((d) => ({ ...d, base: f.version }))}>
              已核对最新版本
            </button>
          </div>
        )}
        <div className="fd-editor-grid">
          <label className="field">
            <span className="field-label">发现类型</span>
            <select aria-label="发现类型" value={draft.kind || ""} onChange={(e) => update("kind", e.target.value)}>
              <option value="">待分类</option>
              <option value="vulnerability">漏洞类</option>
              <option value="informational">信息类</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">风险等级</span>
            <select
              value={draft.kind === "informational" ? "" : draft.severity}
              disabled={draft.kind === "informational"}
              onChange={(e) => update("severity", e.target.value)}
            >
              <option value="">未定级</option>
              {Object.entries(labels)
                .filter(([value]) => !["informational", "ungraded"].includes(value))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          {(
            [
              ["reason", "风险依据"],
              ["impact", "实际影响"],
              ["conditions", "复现条件（每行一条）"],
              ["steps", "复现步骤（每行一条）"],
              ["expected", "正常预期"],
              ["observed", "实际观测"],
              ["remediation", "修复建议"],
            ] as const
          ).map(([field, label]) => (
            <label className="field" key={field}>
              <span className="field-label">{label}</span>
              <textarea
                aria-label={label}
                value={draft[field]}
                onChange={(event) => update(field, event.target.value)}
                rows={3}
              />
            </label>
          ))}
        </div>
        <details className="fd-identity">
          <summary>漏洞身份（用于核对重复发现）</summary>
          <div className="fd-identity-grid">
            {identityFields.map(([field, label]) => (
              <label className="field" key={field}>
                <span className="field-label">{label}</span>
                <input
                  aria-label={label}
                  value={draft.identity[field] || ""}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      identity: { ...d.identity, [field]: event.target.value },
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <div className="fd-editor-actions">
          <button
            type="button"
            className="button primary"
            disabled={ws.busy || draft.base !== f.version}
            onClick={() => void submit()}
          >
            提交修订并重新审核
          </button>
          <button type="button" className="button" onClick={() => setEditing(false)}>
            关闭，保留草稿
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              sessionStorage.removeItem(key);
              setDraft(fromFinding(f));
              setEditing(false);
            }}
          >
            丢弃草稿
          </button>
        </div>
      </section>
    );

  const reviewedCurrent = f.reviewed_version === f.version;
  const final = reviewedCurrent && f.review_status !== "pending";
  const { lead, rest } = splitLead(f.description);
  const conditions = (f.reproduction?.conditions || []).filter(Boolean);
  const steps = (f.reproduction?.steps || []).filter(Boolean);
  const identity = f.identity;
  const identityEntries = Object.entries(identity || {}).filter(([, value]) => text(value));
  const host = text(identity?.host) ? `${identity?.host}${identity?.port ? `:${identity.port}` : ""}` : "";
  const entry = [text(identity?.method), text(identity?.path || identity?.location)].filter(Boolean).join(" ");
  const hasStructured = !!(text(f.impact) || text(f.remediation) || conditions.length || steps.length);
  const hasEvidence = !!(text(f.evidence) || f.evidence_ids.length);
  // 信息级发现通常不适用 CVSS；旧版本留下的向量只作为历史材料。
  const currentCvss = confirmedVulnerability(f, ws.graph!);
  const legacyCvss = !!f.cvss && !currentCvss;

  return (
    <div className="finding-details">
      {f.human_feedback && (
        <p className={f.reviewed_version > f.human_feedback.version ? "quiet" : "banner warn"}>
          人工{f.human_feedback.action === "return" ? "打回" : "重测"}：{f.human_feedback.reason}
          {f.human_feedback.step_id && (
            <>
              {" "}
              · 重测任务{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => locateRecord(ws, f.human_feedback!.step_id!)}
              >
                {f.human_feedback.step_id}
              </button>
            </>
          )}
        </p>
      )}
      {classificationReviewRequired(f, ws.graph!) && (
        <p className="banner warn">历史审核缺少明确分类、有效评分或影响证明，需要复核；暂不计入漏洞库。</p>
      )}
      {f.withdrawn_at && (
        <p className="quiet">决策者已撤回此发现：{f.withdrawal_reason}。来源事实、证据与审核历史仍保留。</p>
      )}
      {f.merged_into && (
        <p className="quiet">
          此发现已合并至{" "}
          <button type="button" className="button small" onClick={() => locateRecord(ws, f.merged_into!)}>
            {f.merged_into}
          </button>
          。{f.merge_reason} 原始内容与审核记录保留作历史。
        </p>
      )}
      <div className="fd-dossier">
        <div className="fd-main">
          {lead && (
            <p className="fd-lead">
              <InlineText text={lead} />
            </p>
          )}

          {(text(f.impact) || text(f.remediation)) && (
            <div className="fd-summary-grid">
              {(findingKind(f) !== "informational" || text(f.impact)) && (
                <section className="fd-summary-item">
                  <span className="fd-kicker">实际影响</span>
                  <p>
                    <InlineText text={text(f.impact) || "尚未提供结构化影响。"} />
                  </p>
                </section>
              )}
              <section className="fd-summary-item">
                <span className="fd-kicker">修复建议</span>
                <p>
                  <InlineText text={text(f.remediation) || "尚未提供修复建议。"} />
                </p>
              </section>
            </div>
          )}

          {/* 复现与验证紧跟影响/修复建议，作为一整块，方便整体复制。 */}
          {(conditions.length > 0 ||
            steps.length > 0 ||
            text(f.reproduction?.expected) ||
            text(f.reproduction?.observed)) && (
            <section className="fd-section fd-repro">
              <header className="fd-section-head">
                <h3>复现与验证</h3>
                {steps.length > 0 && <span>{steps.length} 步</span>}
              </header>
              <div className="fd-repro-grid">
                {conditions.length > 0 && (
                  <div className="fd-repro-conditions">
                    <h4>前提条件</h4>
                    <ul>
                      {conditions.map((condition, index) => (
                        <li key={index}>
                          <InlineText text={condition} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {steps.length > 0 && (
                  <div className="fd-repro-steps">
                    <h4>复现步骤</h4>
                    <ol>
                      {steps.map((step, index) => (
                        <li key={index}>
                          <InlineText text={step} />
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
              {(text(f.reproduction?.expected) || text(f.reproduction?.observed)) && (
                <div className="fd-compare">
                  {text(f.reproduction?.expected) && (
                    <div>
                      <h4>正常预期</h4>
                      <p>
                        <InlineText text={text(f.reproduction?.expected)} />
                      </p>
                    </div>
                  )}
                  {text(f.reproduction?.observed) && (
                    <div>
                      <h4>实际观测</h4>
                      <p>
                        <InlineText text={text(f.reproduction?.observed)} />
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {hasHttpTrafficHint(f) && <FindingTrafficPanel finding={f} />}

          {hasEvidence && (
            <section className="fd-section">
              <header className="fd-section-head">
                <h3>证据与原始材料</h3>
                <span>{f.evidence_ids.length} 份</span>
              </header>
              {text(f.evidence) && (
                <details className="fd-evidence-raw">
                  <summary>证据原文</summary>
                  <pre>{prettyText(f.evidence)}</pre>
                </details>
              )}
              {f.evidence_ids.length > 0 && <div className="fd-evidence-links">{ws.linkEvidence(f.evidence_ids)}</div>}
            </section>
          )}

          {rest &&
            (hasStructured ? (
              <details className="fd-raw">
                <summary>
                  完整记述<span>观测、归因与不确定性</span>
                </summary>
                <RichText text={rest} />
              </details>
            ) : (
              <div className="fd-narrative">
                <RichText text={rest} />
              </div>
            ))}
        </div>

        <aside className="fd-aside" aria-label="发现判定与溯源">
          <section className="fd-card fd-verdict">
            <div className="fd-verdict-head">
              <span className="tag">
                {findingKind(f) === "informational"
                  ? "信息类"
                  : findingKind(f) === "vulnerability"
                    ? "漏洞类"
                    : "待分类"}
              </span>
              {informationalReviewExempt(f) && (
                <span className="tag" title="信息类发现已按当前审核范围直接归档，未启动独立审核。">
                  免审
                </span>
              )}
              {findingKind(f) !== "informational" && (
                <UiSeverityBadge severity={f.severity} prefix={final ? "最终危险度" : "当前危险度"} />
              )}
              <span className="status-pill" data-tone={reviewTone(findingReviewStatus(f))}>
                {findingReviewLabels[findingReviewStatus(f)]}
              </span>
            </div>
            <details className="fd-reason">
              <summary>定级依据</summary>
              <p>
                <InlineText text={text(f.severity_reason) || "尚未提供定级依据。"} />
              </p>
            </details>
            {f.severity_before_review != null && reviewedCurrent && (
              <div className="fd-severity-history">
                <span>复审前</span>
                <UiSeverityBadge severity={f.severity_before_review} />
                {text(f.severity_reason_before_review) && (
                  <p>
                    <InlineText text={text(f.severity_reason_before_review)} />
                  </p>
                )}
              </div>
            )}
          </section>

          {currentCvss && f.cvss && (
            <section className="fd-card fd-cvss">
              <div className="fd-cvss-head">
                <h3>CVSS v4.0</h3>
                <strong>{f.cvss.score.toFixed(1)}</strong>
              </div>
              <code>{f.cvss.vector}</code>
              {text(f.cvss.rationale) && (
                <details>
                  <summary>评分依据</summary>
                  <p>
                    <InlineText text={text(f.cvss.rationale)} />
                  </p>
                </details>
              )}
              <small>分数由应用从 vector 计算，仅作审核报告字段。</small>
            </section>
          )}

          {legacyCvss && f.cvss && (
            <details className="fd-card fd-legacy">
              <summary>历史评分 {f.cvss.score.toFixed(1)} · 不适用</summary>
              <code>{f.cvss.vector}</code>
            </details>
          )}

          {allowActions && <FindingActions finding={f} />}

          {identityEntries.length > 0 && (
            <section className="fd-card">
              <h3>目标与入口</h3>
              <dl className="fd-meta">
                {host && (
                  <div>
                    <dt>主机</dt>
                    <dd className="mono">{host}</dd>
                  </div>
                )}
                {entry && (
                  <div>
                    <dt>入口</dt>
                    <dd>
                      <code>{entry}</code>
                    </dd>
                  </div>
                )}
                {text(identity?.category) && (
                  <div>
                    <dt>类别</dt>
                    <dd>{text(identity?.category)}</dd>
                  </div>
                )}
                {text(identity?.parameter) && (
                  <div>
                    <dt>参数</dt>
                    <dd className="mono">{text(identity?.parameter)}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          <section className="fd-card">
            <h3>溯源</h3>
            <dl className="fd-meta">
              {f.step_id && (
                <div>
                  <dt>来源 Step</dt>
                  <dd>
                    <GraphReference
                      className="fd-link"
                      nodeId={f.step_id}
                      onSelect={() => locateRecord(ws, f.step_id!)}
                    />
                  </dd>
                </div>
              )}
              {f.revision_step_id && (
                <div>
                  <dt>修订 Step</dt>
                  <dd>
                    <GraphReference
                      className="fd-link"
                      nodeId={f.revision_step_id}
                      onSelect={() => locateRecord(ws, f.revision_step_id!)}
                    />
                  </dd>
                </div>
              )}
              {f.from.length > 0 && (
                <div>
                  <dt>来源事实</dt>
                  <dd className="fd-links">
                    {f.from.map((id) => (
                      <GraphReference className="fd-link" key={id} nodeId={id} onSelect={() => locateRecord(ws, id)} />
                    ))}
                  </dd>
                </div>
              )}
              <div>
                <dt>证据</dt>
                <dd>
                  {f.evidence_ids.length} 份 · 版本 v{f.version}
                </dd>
              </div>
              <div>
                <dt>审核版本</dt>
                <dd>
                  {f.reviewed_version ? `v${f.reviewed_version}` : "尚未审核"}
                  {informationalReviewExempt(f) && " · 免审"}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <footer className="fd-footer">
        <span>
          {f.step_id ? `来源 ${f.step_id}` : "未关联来源 Step"} · {fmt(f.created_at)}
        </span>
        <span>发现与项目完成状态相互独立</span>
      </footer>
    </div>
  );
}
