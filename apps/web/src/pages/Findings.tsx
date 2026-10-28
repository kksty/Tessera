import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Pencil, Route, ShieldCheck } from "lucide-react";
import type { Finding } from "../../../../packages/protocol/src/index.js";
import { findingCopyText } from "../copy-finding.js";
import { path } from "../api.js";
import { useViewState } from "../view-state.js";
import { severityLabels, severityOrder, fromNow, reviewTone } from "../format.js";
import {
  findingReviewLabels,
  findingReviewOptions,
  findingReviewStatus,
  type FindingReviewFilter,
} from "../finding-review.js";
import { confirmedVulnerability } from "../project-activity.js";
import {
  findingKind,
  classificationReviewRequired,
  informationalReviewExempt,
  humanApproved,
} from "../../../../packages/protocol/src/finding-policy.js";
import { scopeForFinding } from "../graph-scope.js";
import { Card, EmptyState, Segmented, SeverityBadge } from "../components/ui.js";
import { FindingDetails } from "../components/FindingDetails.js";
import { FindingDuplicates, FindingReports } from "../components/FindingDelivery.js";
import { useWorkspace } from "../workspace.js";

/** 危险度分级只覆盖严重到未定级；信息类没有危险度，单独成组、也单独成页签。 */
const severityKeys = severityOrder.filter((key) => key !== "informational");

function gradeLabel(key: string) {
  return key === "informational" ? "信息类" : severityLabels[key] || "未定级";
}

/**
 * 「查看审核」要落到审核页真实存在的锚点：已审核的发现用最近一条审核记录的
 * id，未审核的用待审核卡片 id。直接用 finding id 会指到不存在的元素。
 */
function reviewAnchor(
  graph: NonNullable<ReturnType<typeof useWorkspace>["graph"]>,
  finding: { id: string; version: number },
) {
  const reviews = graph.reviews.filter((review) => review.finding_id === finding.id);
  const exact = reviews.filter((review) => review.finding_version === finding.version).at(-1);
  const latest = exact ?? reviews.at(-1);
  return latest ? `review-${latest.id}` : `pending-review-${finding.id}`;
}

export function FindingsPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const id = ws.id!;
  const [filter, setFilter] = useViewState<FindingReviewFilter>(`${graph.project.id}:findings:filter`, "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState("active");
  // 顶部「修订」按钮向详情组件下达进入编辑的信号。
  const [editSignal, setEditSignal] = useState(0);
  // 复制某个发现的描述后短暂回显「已复制」。
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const appliedFocus = useRef<typeof ws.focusFinding>(null);
  const risk = ws.findingSeverity;

  const lifecycleFindings = useMemo(
    () =>
      graph.findings.filter(
        (finding) =>
          !finding.merged_into && (lifecycle === "withdrawn" ? !!finding.withdrawn_at : !finding.withdrawn_at),
      ),
    [graph.findings, lifecycle],
  );

  // Operator approval is a version-bound gate: approved findings leave the pending
  // queues and are listed under "已批准"; a revision must be approved again.
  const [approval, setApproval] = useViewState<"pending" | "approved">(
    `${graph.project.id}:findings:approval`,
    "pending",
  );
  const approvalCounts = useMemo(() => {
    let approved = 0;
    for (const finding of lifecycleFindings) if (humanApproved(finding)) approved += 1;
    return { approved, pending: lifecycleFindings.length - approved };
  }, [lifecycleFindings]);
  const approvalFindings = useMemo(
    () => lifecycleFindings.filter((finding) => humanApproved(finding) === (approval === "approved")),
    [lifecycleFindings, approval],
  );

  /** 页签即分级：「全部」保留信息类，「已确认」只留审核通过且评分有效的漏洞，等级页签按当前危险度收窄。 */
  const scopedFindings = useMemo(
    () =>
      approvalFindings.filter((finding) => {
        const informational = findingKind(finding) === "informational";
        if (risk === "informational") return informational;
        if (informational) return risk === "all";
        if (risk === "all") return true;
        if (risk === "confirmed") return confirmedVulnerability(finding, graph);
        return (finding.severity || "ungraded") === risk;
      }),
    [approvalFindings, risk, graph],
  );

  const counts = useMemo(() => {
    const bySeverity: Record<string, number> = Object.fromEntries(severityKeys.map((key) => [key, 0]));
    let confirmed = 0;
    let informational = 0;
    for (const finding of approvalFindings) {
      if (findingKind(finding) === "informational") {
        informational += 1;
        continue;
      }
      bySeverity[finding.severity || "ungraded"] += 1;
      if (confirmedVulnerability(finding, graph)) confirmed += 1;
    }
    return { bySeverity, confirmed, informational, total: approvalFindings.length };
  }, [approvalFindings, graph]);

  const tabs = useMemo(() => {
    const list: { key: string; label: string; count: number; severity?: string }[] = [
      { key: "all", label: "全部", count: counts.total },
    ];
    if (counts.confirmed > 0 || risk === "confirmed")
      list.push({ key: "confirmed", label: "已确认", count: counts.confirmed });
    for (const key of severityKeys)
      if (counts.bySeverity[key] > 0 || risk === key)
        list.push({ key, label: severityLabels[key], count: counts.bySeverity[key], severity: key });
    if (counts.informational > 0 || risk === "informational")
      list.push({ key: "informational", label: "信息类", count: counts.informational, severity: "informational" });
    return list;
  }, [counts, risk]);

  const findings = useMemo(
    () => scopedFindings.filter((finding) => filter === "all" || findingReviewStatus(finding) === filter),
    [scopedFindings, filter],
  );

  /** 列表按危险度分节；信息类始终单列在最后，「信息类」页签下则只剩这一节。 */
  const groups = useMemo(
    () =>
      (risk === "informational" ? ["informational"] : [...severityKeys, "informational"])
        .map((key) => ({
          key,
          items: findings.filter((finding) =>
            key === "informational"
              ? findingKind(finding) === "informational"
              : findingKind(finding) !== "informational" && (finding.severity || "ungraded") === key,
          ),
        }))
        .filter((group) => group.items.length > 0),
    [findings, risk],
  );

  // 默认选中第一条；筛选变化时若当前项被隐藏，重新选中。
  useEffect(() => {
    if (!findings.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !findings.some((finding) => finding.id === selectedId)) setSelectedId(findings[0].id);
  }, [findings, selectedId]);

  // 从总览 / 漏洞库 / 审核页带过来的定位请求。
  useEffect(() => {
    if (!ws.focusFinding || ws.focusFinding.projectId !== graph.project.id || appliedFocus.current === ws.focusFinding)
      return;
    let target = graph.findings.find((finding) => finding.id === ws.focusFinding!.findingId);
    const visited = new Set<string>();
    while (target?.merged_into && !visited.has(target.id)) {
      visited.add(target.id);
      target = graph.findings.find((f) => f.id === target!.merged_into);
    }
    if (!target) return;
    appliedFocus.current = ws.focusFinding;
    ws.setFindingSeverity("all");
    setFilter("all");
    setApproval(humanApproved(target) ? "approved" : "pending");
    setLifecycle(target.withdrawn_at ? "withdrawn" : "active");
    setSelectedId(target.id);
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-finding="${target.id}"]`)?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [ws.focusFinding, graph.project.id, graph.findings]);

  const selected = findings.find((finding) => finding.id === selectedId) || null;

  // 复制单个发现的完整描述，便于整体粘贴到工单/文档。
  async function copySelected(finding: Finding) {
    const payload = findingCopyText(finding);
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // 非安全上下文没有剪贴板权限时退回选区复制。
      const area = document.createElement("textarea");
      area.value = payload;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopiedId(finding.id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1600);
  }

  const renderFinding = (finding: Finding) => {
    const identity = finding.identity;
    const host = identity?.host
      ? `${identity.host}${identity.port ? `:${identity.port}` : ""}`
      : graph.assets.find((asset) => asset.id === finding.asset_id)?.hostname;
    const active = finding.id === selectedId;
    const reviewStatus = findingReviewStatus(finding);
    return (
      <button
        type="button"
        key={finding.id}
        id={`finding-${finding.id}`}
        data-finding={finding.id}
        className="finding-item"
        data-active={active || undefined}
        data-severity={finding.severity || "ungraded"}
        onClick={() => setSelectedId(finding.id)}
      >
        <span className="finding-item-rail" aria-hidden="true" />
        <span className="finding-item-body">
          <span className="finding-item-top">
            <span className="tag">
              {findingKind(finding) === "informational"
                ? "信息类"
                : findingKind(finding) === "vulnerability"
                  ? "漏洞类"
                  : "待分类"}
            </span>
            {findingKind(finding) !== "informational" && <SeverityBadge severity={finding.severity} />}
            {informationalReviewExempt(finding) && (
              <span className="tag" title="信息类发现已按当前审核范围直接归档，未启动独立审核。">
                免审
              </span>
            )}
            {humanApproved(finding) && (
              <span className="tag" title="已由操作员人工批准；不进入待处理列表">
                已批准
              </span>
            )}
            <span className="status-pill" data-tone={reviewTone(reviewStatus)}>
              {findingReviewLabels[reviewStatus]}
            </span>
            {classificationReviewRequired(finding, graph) && <span className="finding-warn">旧结论需复核</span>}
            {finding.reviewed_version > 0 && finding.reviewed_version !== finding.version && (
              <span className="finding-warn">待复审</span>
            )}
            <span className="spacer" />
            <span className="mono quiet">{finding.id}</span>
          </span>
          <span className="finding-item-title">{finding.title}</span>
          <span className="finding-item-meta">
            {host && <span className="mono">{host}</span>}
            {finding.step_id && <span className="mono">{finding.step_id}</span>}
            <span>{fromNow(finding.created_at)}</span>
          </span>
        </span>
      </button>
    );
  };

  return (
    <>
      <section className="page page-findings">
        <header className="page-header">
          <div className="page-header-main">
            <span className="eyebrow">DELIVERABLE / FINDINGS</span>
            <h1>发现</h1>
            <p className="page-lede">
              项目内所有结论记录：候选、审核中、已确认与已驳回。按「未批准 / 已批准」分组，再按危险度分级排列；信息类没有危险度，单独成页签。
            </p>
          </div>
          <div className="page-actions">
            <FindingReports variant="menu" />
            <a className="button" href={"/api" + path(id, "/export?format=findings")}>
              <Download size={14} />
              导出发现
            </a>
          </div>
        </header>

        <div className="findings-stats">
          <div className="findings-stat">
            <span className="findings-stat-num">{counts.total}</span>
            <span className="findings-stat-label">发现总数</span>
          </div>
          <div className="findings-stat" data-tone="danger">
            <span className="findings-stat-num">{counts.confirmed}</span>
            <span className="findings-stat-label">已确认漏洞</span>
          </div>
          <div className="findings-stat">
            <span className="findings-stat-num">{approvalCounts.pending}</span>
            <span className="findings-stat-label">待批准</span>
          </div>
          <div className="findings-stat">
            <span className="findings-stat-num">{findings.length}</span>
            <span className="findings-stat-label">当前筛选</span>
          </div>
        </div>

        <div className="toolbar findings-toolbar">
          <Segmented
            ariaLabel="发现批准状态"
            value={approval}
            onChange={(value) => {
              setApproval(value);
              setFilter("all");
            }}
            options={[
              ["pending", `未批准 ${approvalCounts.pending}`],
              ["approved", `已批准 ${approvalCounts.approved}`],
            ]}
          />
          <span className="spacer" />
          <Segmented
            ariaLabel="发现审核筛选"
            value={filter}
            onChange={setFilter}
            options={findingReviewOptions(scopedFindings)}
          />
          <select aria-label="发现保留状态" value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
            <option value="active">当前发现</option>
            <option value="withdrawn">已撤回</option>
          </select>
        </div>

        {lifecycleFindings.length > 0 && (
          <div className="severity-tabs findings-tabs" role="group" aria-label="按严重程度分级">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={risk === tab.key ? "active" : ""}
                data-severity={tab.severity}
                aria-pressed={risk === tab.key}
                title={tab.key === "all" ? "全部发现；信息类单列在最后一节，也可点「信息类」单独查看" : undefined}
                onClick={() => ws.setFindingSeverity(tab.key)}
              >
                {tab.severity && <span className="severity-tab-dot" aria-hidden="true" />}
                <span>{tab.label}</span>
                <b>{tab.count}</b>
              </button>
            ))}
          </div>
        )}

        {findings.length ? (
          <div className="findings-split">
            <div className="finding-list" ref={listRef}>
              {groups.map((group) => (
                <section className="finding-group" key={group.key}>
                  <header className="finding-group-head" data-severity={group.key}>
                    <span className="finding-group-dot" aria-hidden="true" />
                    <span className="finding-group-name">{gradeLabel(group.key)}</span>
                    <span className="finding-group-count">{group.items.length}</span>
                    <span className="finding-group-line" aria-hidden="true" />
                  </header>
                  {group.items.map(renderFinding)}
                </section>
              ))}
            </div>

            <aside className="finding-detail-panel">
              {selected ? (
                <>
                  <header className="finding-detail-head">
                    <div className="finding-detail-top">
                      <div className="finding-detail-idline">
                        <span className="mono finding-detail-id">{selected.id}</span>
                        <span className="tag">
                          {findingKind(selected) === "informational"
                            ? "信息类"
                            : findingKind(selected) === "vulnerability"
                              ? "漏洞类"
                              : "待分类"}
                        </span>
                        {findingKind(selected) !== "informational" && (
                          <SeverityBadge severity={selected.severity} />
                        )}
                        <span className="status-pill" data-tone={reviewTone(findingReviewStatus(selected))}>
                          {findingReviewLabels[findingReviewStatus(selected)]}
                        </span>
                        {humanApproved(selected) && (
                          <span className="tag" title="已由操作员人工批准；不进入待处理列表">
                            已批准
                          </span>
                        )}
                        {classificationReviewRequired(selected, graph) && (
                          <span className="finding-warn">旧结论需复核</span>
                        )}
                        {selected.reviewed_version > 0 && selected.reviewed_version !== selected.version && (
                          <span className="finding-warn">待复审</span>
                        )}
                        <span className="mono quiet finding-detail-version">v{selected.version}</span>
                      </div>
                      <div className="finding-detail-actions">
                        <button
                          type="button"
                          className="button ghost small"
                          title="复制这条发现的完整描述（标题、影响、复现、修复、身份与证据）"
                          onClick={() => void copySelected(selected)}
                        >
                          {copiedId === selected.id ? <Check size={14} /> : <Copy size={14} />}
                          {copiedId === selected.id ? "已复制" : "复制描述"}
                        </button>
                        <button
                          type="button"
                          className="button ghost small"
                          onClick={() => {
                            setEditSignal((value) => value + 1);
                          }}
                        >
                          <Pencil size={14} />
                          修订
                        </button>
                        <button
                          type="button"
                          className="button small"
                          onClick={() =>
                            ws.navigate("review", {
                              anchor: reviewAnchor(graph, selected),
                            })
                          }
                        >
                          <ShieldCheck size={14} />
                          查看审核
                        </button>
                        <button
                          type="button"
                          className="button small"
                          onClick={() => ws.openInGraph(scopeForFinding(graph, selected.id))}
                        >
                          <Route size={14} />
                          发现链路
                        </button>
                      </div>
                    </div>
                    <h2>{selected.title}</h2>
                  </header>
                  <div className="finding-detail-body">
                    <FindingDetails key={selected.id} finding={selected} allowActions editSignal={editSignal} />
                  </div>
                </>
              ) : (
                <EmptyState compact title="选择一条发现" desc="左侧列出当前筛选下的所有结论。" />
              )}
            </aside>
          </div>
        ) : (
          <Card>
            <EmptyState
              title={graph.findings.length ? "没有符合筛选条件的发现" : "尚无发现"}
              desc="Finding 与项目是否完成相互独立：模型可以在任何一轮提交候选结论。"
            />
          </Card>
        )}
      </section>

      {/* 去重候选跟在两栏之后，不参与两栏的高度分配；否则它会挤压列表与详情。 */}
      <div className="page page-findings-extra">
        <FindingDuplicates />
      </div>
    </>
  );
}
