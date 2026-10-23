import { useMemo, useState } from "react";
import { ArrowUpRight, ClipboardCheck, Clock3, FileSearch, RefreshCw, ShieldCheck } from "lucide-react";
import type { Finding, Review } from "../../../../packages/protocol/src/index.js";
import { pendingReviews, type ReviewGate } from "../../../../packages/protocol/src/review-scheduling.js";
import { reviewIssueRisk } from "../../../../packages/protocol/src/review-issues.js";
import { findingKind, classificationReviewRequired } from "../../../../packages/protocol/src/finding-policy.js";
import { RichText, splitLead } from "../components/RichText.js";
import { Card, EmptyState, Kpi, Modal, PageHeader, Segmented, SeverityBadge } from "../components/ui.js";
import { api, path } from "../api.js";
import { fmt, fromNow, pct, reviewTone, statusLabels, verdictLabel } from "../format.js";
import { useViewState } from "../view-state.js";
import { useWorkspace } from "../workspace.js";
import { FindingKindBadge } from "../components/FindingKindBadge.js";
import { ReauditButton } from "../components/ReauditButton.js";
import { reviewedFindingSnapshot, reviewVersionLabel } from "../review-history.js";

type VerdictFilter = "all" | "pass" | "needs_evidence" | "rejected";

const PENDING_PAGE = 8;
const REVIEW_PAGE = 20;

const verdictOptions = [
  ["all", "全部"],
  ["pass", "通过"],
  ["needs_evidence", "需补证"],
  ["rejected", "驳回"],
] as const;

function pendingGate(finding: Finding, gate: ReviewGate) {
  const labels: Record<ReviewGate, string> = {
    ready: "等待审核模型领取",
    reviewing: "审核模型正在处理",
    inactive: "项目已暂停或完成",
    current: "当前版本已有审核结果",
    excluded: "发现已合并或撤回",
    source_unfinished: "等待执行结束",
    asset_unapproved: "等待资产批准",
    backoff: "等待重试",
    review_limit: "等待审核并发空位",
  };
  return {
    tone: gate === "reviewing" ? "accent" : gate === "ready" ? "idle" : "warn",
    label: labels[gate],
    ref:
      gate === "reviewing"
        ? finding.review_worker
        : gate === "source_unfinished"
          ? finding.revision_step_id || finding.step_id
          : gate === "backoff" && finding.retry_at
            ? fmt(finding.retry_at)
            : "",
  };
}

/** 目标身份：主机、端口、入口与参数，取自发现本身的身份字段。 */
function identityRows(finding?: Pick<Finding, "identity">): [string, string][] {
  const identity = finding?.identity;
  if (!identity) return [];
  const rows: [string, string][] = [];
  if (identity.host) rows.push(["主机", identity.host]);
  if (identity.port) rows.push(["端口", String(identity.port)]);
  const entry = [identity.method, identity.path || identity.location].filter(Boolean).join(" ");
  if (entry) rows.push(["入口", entry]);
  if (identity.parameter) rows.push(["参数", identity.parameter]);
  return rows;
}

function PendingRow({ finding, state }: { finding: Finding; state: ReviewGate }) {
  const ws = useWorkspace();
  const gate = pendingGate(finding, state);
  return (
    <article className="review-pending-row" id={`pending-review-${finding.id}`} data-gate={gate.tone} tabIndex={-1}>
      <span className="review-pending-dot" aria-hidden="true" />
      <div className="review-pending-main">
        <div className="review-pending-head">
          <FindingKindBadge kind={findingKind(finding)} />
          {findingKind(finding) !== "informational" && <SeverityBadge severity={finding.severity} />}
          <h3 className="review-pending-title">{finding.title}</h3>
        </div>
        <div className="review-pending-meta">
          <span className="mono">发现 {finding.id}</span>
          <span className="review-sep" aria-hidden="true" />
          <span>当前第 {finding.version} 版</span>
          {classificationReviewRequired(finding, ws.graph!) && <span>旧结论需复核</span>}
          {finding.reviewed_version > 0 && finding.reviewed_version !== finding.version && (
            <>
              <span className="review-sep" aria-hidden="true" />
              <span>已审第 {finding.reviewed_version} 版</span>
            </>
          )}
          <span className="review-sep" aria-hidden="true" />
          <span>{fromNow(finding.created_at)}提交</span>
        </div>
        <p className="review-pending-gate">
          <Clock3 size={12} aria-hidden="true" />
          {gate.label}
          {gate.ref && <span className="review-pending-ref">{gate.ref}</span>}
        </p>
      </div>
      <div className="review-pending-actions">
        {state === "inactive" && <ReauditButton projectId={ws.graph!.project.id} label="开始复核" />}
        <button
          type="button"
          className="button small"
          onClick={() => ws.navigate("findings", { anchor: `finding-${finding.id}` })}
        >
          查看发现
        </button>
        <button type="button" className="button small ghost" onClick={() => ws.openInGraph({ ids: [finding.id] })}>
          打开链路
        </button>
      </div>
    </article>
  );
}

function ReviewRecord({ review, finding }: { review: Review; finding?: Finding }) {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const [waiving, setWaiving] = useState<number | null>(null);
  const [waiverReason, setWaiverReason] = useState("");
  const snapshot = reviewedFindingSnapshot(finding, review);
  const kind = review.kind ?? null;
  const severityNow = review.severity ?? null;
  const severityBefore = review.severity_before_review ?? null;
  const changed = !!severityBefore && severityBefore !== severityNow;
  const { lead: sourceLead, rest: sourceRest } = splitLead(review.reason);
  // splitLead 会把单段长文整段当作导语；这里在 200 字后按句末标点再切一刀，长文仍然可以收起。
  let lead = sourceLead;
  let rest = sourceRest;
  if (!rest && lead.length > 400) {
    const boundary = lead.slice(200).search(/[。！？；\n]/);
    if (boundary >= 0) {
      const at = 200 + boundary + 1;
      rest = lead.slice(at).trim();
      lead = lead.slice(0, at).trim();
    }
  }
  const folded = rest.length > 400 || (!!lead && rest.length > 120);
  const identity = identityRows(snapshot);

  const openFinding = () => {
    if (finding) ws.navigate("findings", { anchor: `finding-${finding.id}` });
  };

  return (
    <article className="review-card" id={`review-${review.id}`} data-verdict={review.verdict} tabIndex={-1}>
      <header className="review-card-head">
        <div className="review-card-ident">
          <span className="status-pill" data-tone={reviewTone(review.verdict)}>
            <i aria-hidden="true" />
            {verdictLabel[review.verdict] || statusLabels[review.verdict] || review.verdict}
          </span>
          <FindingKindBadge kind={kind} unknownLabel="当次未记录分类" />
          {kind !== "informational" && <SeverityBadge severity={severityNow} prefix="当次审核" />}
          {finding && review.finding_version < finding.version && (
            <span
              className="status-pill"
              data-tone="neutral"
              title="这是旧版本的审核记录。发现已修订，当前版本须以自己的审核结果为准。"
            >
              历史审核 · 当前第 {finding.version} 版
            </span>
          )}
        </div>
        <button
          type="button"
          className="review-finding"
          disabled={!finding}
          onClick={openFinding}
          title={finding ? `在发现页定位 ${finding.id}` : `未找到关联发现 ${review.finding_id}`}
        >
          {snapshot?.title || review.finding_id}
          {finding && <ArrowUpRight size={12} aria-hidden="true" />}
        </button>
      </header>

      <div className="review-card-meta">
        <span className="mono">审核 {review.id}</span>
        <span className="review-sep" aria-hidden="true" />
        <span className="mono">{reviewVersionLabel(review)}</span>
        <span className="review-sep" aria-hidden="true" />
        <span>{fmt(review.created_at)}</span>
        <span className="review-sep" aria-hidden="true" />
        <span className="mono" title={review.worker}>
          执行者 {review.worker}
        </span>
        <span>{review.source === "human" ? "人工处理" : "模型审核"}</span>
        <span className="review-sep" aria-hidden="true" />
        <span>{review.evidence_ids.length} 份证据</span>
        {review.verification_step_id && (
          <>
            <span className="review-sep" aria-hidden="true" />
            <span>
              验证 <span className="mono">{review.verification_step_id}</span>
            </span>
          </>
        )}
      </div>

      <div className="split-grid review-dossier">
        <div className="review-main">
          {lead && <RichText text={lead} className="review-lead" />}
          {rest &&
            (folded ? (
              <details className="review-fold">
                <summary>
                  {lead ? "展开其余理由" : "展开完整理由"} · {rest.length} 字
                </summary>
                <RichText text={rest} className="review-reason" />
              </details>
            ) : (
              <RichText text={rest} className="review-reason" />
            ))}
          {!lead && !rest && <p className="review-muted">未提供审核理由。</p>}

          {review.verification && (
            <section className="review-suggestion">
              <span className="review-kicker">建议核查</span>
              <RichText text={review.verification} className="review-suggestion-text" />
              {review.verification_step_id && (
                <button
                  type="button"
                  className="button small"
                  onClick={() =>
                    ws.openInGraph({
                      ids: [review.verification_step_id!],
                      label: `验证 ${review.verification_step_id}`,
                    })
                  }
                >
                  查看验证任务
                  <ArrowUpRight size={12} aria-hidden="true" />
                </button>
              )}
            </section>
          )}

          {!!review.planning_issues?.length && (
            <section className="review-suggestion review-issues">
              <span className="review-kicker">需要处置的审核问题</span>
              {review.planning_issues.map((issue, index) => {
                const waiver = review.issue_waivers?.find((item) => item.index === index);
                const high = reviewIssueRisk(issue) === "high";
                return (
                  <div className="review-issue" key={index}>
                    <div className="review-card-ident">
                      <span className="status-pill" data-tone={high ? "warn" : "neutral"}>
                        {high ? "高风险" : "常规"}
                      </span>
                      <span className="mono">
                        {review.id}#{index}
                      </span>
                      {waiver && (
                        <span className="status-pill" data-tone="accent">
                          人工豁免
                        </span>
                      )}
                    </div>
                    <RichText text={issue} className="review-reason" />
                    {waiver ? (
                      <p className="quiet">
                        豁免理由：{waiver.reason}（{waiver.by}）{" "}
                        <button
                          type="button"
                          className="button small ghost"
                          disabled={ws.busy || graph.project.status === "completed"}
                          onClick={() =>
                            void ws.action(() =>
                              api(
                                path(graph.project.id, `/reviews/${review.id}/issues/${index}/waive`),
                                undefined,
                                "DELETE",
                              ),
                            )
                          }
                        >
                          撤销豁免
                        </button>
                      </p>
                    ) : (
                      <div>
                        <button
                          type="button"
                          className="button small"
                          disabled={ws.busy || graph.project.status === "completed"}
                          title={
                            high
                              ? "高风险问题不能由 Decide 驳回；由操作员在此确认豁免"
                              : "豁免后 Decide 可用理由关闭此问题"
                          }
                          onClick={() => {
                            setWaiverReason("");
                            setWaiving(index);
                          }}
                        >
                          人工豁免
                        </button>
                        <small>未处置前 Decide 不能完成；高风险问题必须有此人工决定。</small>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <aside className="review-aside">
          {(severityNow || severityBefore || review.severity_reason || review.cvss) && (
            <section className="review-aside-block">
              <span className="review-kicker">定级与评分</span>
              {changed ? (
                <div className="review-severity-shift">
                  <SeverityBadge severity={severityBefore} prefix="复审前" />
                  <span aria-hidden="true">→</span>
                  <SeverityBadge severity={severityNow} prefix="复审后" />
                </div>
              ) : (
                <SeverityBadge severity={severityNow} />
              )}
              {review.severity_reason && (
                <details className="review-fold">
                  <summary>定级依据</summary>
                  <RichText text={review.severity_reason} />
                </details>
              )}
              {review.cvss && (
                <div className="review-cvss">
                  <div className="review-cvss-head">
                    <span className="review-kicker">CVSS v4.0</span>
                    <strong className="review-cvss-score mono">{review.cvss.score.toFixed(1)}</strong>
                  </div>
                  <code className="review-cvss-vector">{review.cvss.vector}</code>
                  {!!review.cvss.impact_evidence?.length && (
                    <details className="review-fold">
                      <summary>实际影响证明 · {review.cvss.impact_evidence.length} 项</summary>
                      {review.cvss.impact_evidence.map((claim) => (
                        <div key={claim.metric}>
                          <strong>
                            {claim.metric} · {claim.affected}
                          </strong>
                          <RichText text={`安全边界：${claim.boundary}\n\n已证明后果：${claim.consequence}`} />
                          {ws.linkEvidence(claim.evidence_ids)}
                        </div>
                      ))}
                    </details>
                  )}
                  {review.cvss.rationale && (
                    <details className="review-fold">
                      <summary>评分依据</summary>
                      <RichText text={review.cvss.rationale} />
                    </details>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="review-aside-block">
            <span className="review-kicker">审核对象</span>
            {identity.length > 0 ? (
              <dl className="review-identity">
                {identity.map(([label, value]) => (
                  <div key={label} className="review-identity-row">
                    <dt>{label}</dt>
                    <dd className="mono">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="review-muted">未记录目标身份。</p>
            )}
          </section>

          {review.evidence_ids.length > 0 && (
            <section className="review-aside-block">
              <span className="review-kicker">证据</span>
              <div className="review-evidence">{ws.linkEvidence(review.evidence_ids)}</div>
            </section>
          )}

          {review.disputed_fact_ids.length > 0 && (
            <section className="review-aside-block">
              <span className="review-kicker">争议事实</span>
              <div className="review-disputes">
                {review.disputed_fact_ids.map((id) => (
                  <button
                    type="button"
                    className="review-chip"
                    key={id}
                    title="在黑板中查看这些争议事实"
                    onClick={() =>
                      ws.openInGraph({
                        ids: review.disputed_fact_ids,
                        label: `争议事实 · ${review.disputed_fact_ids.length} 项`,
                      })
                    }
                  >
                    {id}
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      <footer className="review-card-foot">
        <ClipboardCheck size={12} aria-hidden="true" />
        <span className="mono">{review.id}</span>
        <span>此结论仅适用于第 {review.finding_version} 版</span>
        {finding && review.finding_version < finding.version && (
          <button type="button" className="button small ghost" onClick={openFinding}>
            查看当前第 {finding.version} 版
          </button>
        )}
        {finding?.merged_into && <span>已合并至 {finding.merged_into}，此记录保留作历史</span>}
        {finding?.withdrawn_at && <span>发现已撤回，此记录保留作历史</span>}
      </footer>
      {waiving !== null && (
        <Modal
          label="人工豁免审核问题"
          title={`${review.id} 问题 #${waiving}`}
          onClose={() => setWaiving(null)}
          onSubmit={(event) => {
            event.preventDefault();
            void ws
              .action(() =>
                api(
                  path(graph.project.id, `/reviews/${review.id}/issues/${waiving}/waive`),
                  { reason: waiverReason.trim(), by: "human" },
                  "POST",
                ),
              )
              .then((ok) => {
                if (ok) setWaiving(null);
              });
          }}
          footer={
            <>
              <button type="button" onClick={() => setWaiving(null)}>
                取消
              </button>
              <button className="primary" disabled={ws.busy || !waiverReason.trim()}>
                确认豁免
              </button>
            </>
          }
        >
          <p className="review-reason">{review.planning_issues?.[waiving]}</p>
          <label>
            豁免理由
            <textarea
              aria-label="审核问题豁免理由"
              value={waiverReason}
              onChange={(event) => setWaiverReason(event.target.value)}
              rows={4}
              required
              placeholder="例如：已人工核对原始证据，该入口的访问控制由网关统一校验"
            />
          </label>
          <p className="quiet">
            豁免只关闭这一条审核问题，不会替 Decide 建任务或关闭 Hint/Coverage；高风险问题没有此步骤时完成会被拒绝。
          </p>
        </Modal>
      )}
    </article>
  );
}

export function ReviewPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const [verdict, setVerdict] = useViewState<VerdictFilter>(`${graph.project.id}:review:verdict`, "all");
  const [pendingOpen, setPendingOpen] = useViewState(`${graph.project.id}:review:pending-expanded`, false);
  const [reviewLimit, setReviewLimit] = useViewState(`${graph.project.id}:review:limit`, REVIEW_PAGE);

  const pending = useMemo(
    () =>
      pendingReviews(graph, Math.min(ws.config?.max_project_workers ?? 4, ws.config?.max_project_review_workers ?? 1)),
    [graph, ws.config],
  );
  const reviews = useMemo(() => {
    const at = (review: Review) => Date.parse(review.created_at) || 0;
    return [...graph.reviews].sort((a, b) => at(b) - at(a));
  }, [graph.reviews]);
  const passed = reviews.filter((review) => review.verdict === "pass").length;
  const needsEvidence = reviews.filter((review) => review.verdict === "needs_evidence").length;
  const matching = verdict === "all" ? reviews : reviews.filter((review) => review.verdict === verdict);
  const visibleReviews = matching.slice(0, reviewLimit);
  const visiblePending = pendingOpen ? pending : pending.slice(0, PENDING_PAGE);
  const findingsById = useMemo(() => new Map(graph.findings.map((finding) => [finding.id, finding])), [graph.findings]);
  const empty = !pending.length && !reviews.length;

  return (
    <section className="page page-review">
      <PageHeader
        eyebrow="QUALITY / REVIEW"
        title="审核队列"
        description="独立审核模型自动核查关键结论与原始证据。进入审核的发现会写明它卡在哪一步：执行、领取还是重试；这里只读查看进度与结论。"
        actions={
          <>
            <span className="status-pill" data-tone={pending.length ? "warn" : "neutral"}>
              {pending.length} 项审核中
            </span>
            <button type="button" className="button" onClick={() => ws.navigate("findings")}>
              查看全部发现
            </button>
            <button type="button" className="button" disabled={ws.refreshing} onClick={() => void ws.refresh()}>
              <RefreshCw size={13} className={ws.refreshing ? "spin" : ""} aria-hidden="true" />
              刷新
            </button>
          </>
        }
      />

      <details className="review-notation">
        <summary>编号、版本和审核状态怎么看？</summary>
        <p>
          <strong>发现 v002</strong> 是第 2 条发现的固定编号；<strong>第 1 版 / 第 2 版</strong>{" "}
          是同一发现修订前后的内容；<strong>审核 r002</strong> 是一条独立审核记录。
        </p>
        <p>
          “历史审核 · 当前第 2 版”表示这里审的是旧版，修订后的版本仍须重新审核，不代表新版已通过。“当次未记录分类 /
          未定级”只描述这次审核保存的结果。
        </p>
        <p>
          “需要补充证据”也可能是正文数量错误、字段遗漏，需要先更正再审。旧审核和证据会保留；来源任务执行完毕、发现就绪后即可审核，同时继续探索。
        </p>
      </details>

      <div className="kpi-grid">
        <Kpi
          label="审核中"
          value={pending.length}
          tone={pending.length ? "warn" : "neutral"}
          note={
            pending.length
              ? `占全部发现 ${pct(pending.length, graph.findings.length)}% · 审核模型自动处理`
              : "队列已清空"
          }
          icon={<Clock3 size={15} aria-hidden="true" />}
        />
        <Kpi
          label="已审核"
          value={reviews.length}
          tone="accent"
          note={reviews.length ? "审核记录总数，含多版本复审" : "还没有审核记录"}
          icon={<ClipboardCheck size={15} aria-hidden="true" />}
        />
        <Kpi
          label="审核通过"
          value={passed}
          tone="success"
          note={`通过率 ${pct(passed, reviews.length)}%`}
          icon={<ShieldCheck size={15} aria-hidden="true" />}
        />
        <Kpi
          label="需要补证"
          value={needsEvidence}
          tone="warn"
          note={`占审核记录 ${pct(needsEvidence, reviews.length)}%`}
          icon={<FileSearch size={15} aria-hidden="true" />}
        />
      </div>

      {empty ? (
        <Card className="review-empty">
          <EmptyState
            title="还没有进入审核的发现"
            desc="关键发现提交后会进入审核：通过、指出缺证据或驳回。审核记录与队列都会显示在这里。"
            action={
              <button type="button" className="button" onClick={() => ws.navigate("findings")}>
                查看全部发现
              </button>
            }
          />
        </Card>
      ) : (
        <div className="review-stack">
          <Card
            className="review-pending-card"
            title="审核队列"
            note={pending.length ? `${pending.length} 项在队列中 · 审核模型自动处理` : "没有发现等待审核"}
            icon={<Clock3 size={15} aria-hidden="true" />}
            flush
            actions={
              pending.length > PENDING_PAGE ? (
                <button type="button" className="button small ghost" onClick={() => setPendingOpen((value) => !value)}>
                  {pendingOpen ? "收起列表" : `显示全部 ${pending.length} 项`}
                </button>
              ) : undefined
            }
          >
            {pending.length > 0 ? (
              <div className="review-pending-list">
                {visiblePending.map(({ finding, gate }) => (
                  <PendingRow key={finding.id} finding={finding} state={gate} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="队列已清空" desc="新提交或修订的发现会自动进入这里，并写明它在等什么。" />
            )}
          </Card>

          <Card
            className="review-records"
            title="审核记录"
            note={`${reviews.length} 条 · 最新在前`}
            icon={<ClipboardCheck size={15} aria-hidden="true" />}
            flush
            actions={
              <Segmented
                ariaLabel="审核结论筛选"
                size="sm"
                value={verdict}
                onChange={(next) => {
                  setVerdict(next);
                  setReviewLimit(REVIEW_PAGE);
                }}
                options={verdictOptions}
              />
            }
          >
            {visibleReviews.length > 0 ? (
              <div className="review-list">
                {visibleReviews.map((review) => (
                  <ReviewRecord key={review.id} review={review} finding={findingsById.get(review.finding_id)} />
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                title="该结论下还没有审核记录"
                desc="切换到「全部」可以看每一次审核的结论、定级与证据。"
              />
            )}
            {matching.length > reviewLimit && (
              <div className="review-more">
                <button
                  type="button"
                  className="button small"
                  onClick={() => setReviewLimit((value) => value + REVIEW_PAGE)}
                >
                  显示更早审核 · 还有 {matching.length - reviewLimit} 条
                </button>
              </div>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}
