import {
  ArrowUpRight,
  Clock3,
  FolderKanban,
  Gauge,
  Globe2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { OverviewAttention, OverviewProject } from "../../../../packages/protocol/src/index.js";
import { fromNow, fmt } from "../format.js";
import { SeverityRows, TokenTrendChart, TrendChart } from "../components/charts.js";
import { Card, EmptyState, Kpi, PageHeader, SeverityBadge, StatusPill } from "../components/ui.js";
import { readableError, useWorkspace } from "../workspace.js";
import { reviewSummary } from "../review-queue.js";

const attentionTitle = (item: OverviewAttention) => {
  if (item.kind === "review") return `${item.count} 条漏洞正在审核`;
  if (item.kind === "assets") return `${item.count} 个资产待批准`;
  return `${item.count} 项运行需检查`;
};

const attentionDetail = (item: OverviewAttention) => {
  if (item.kind === "error" && /timeout|aborted/i.test(item.detail)) {
    return "执行超时，任务与证据已保留；请检查后继续。";
  }
  const plain = (item.kind === "error" ? readableError(item.detail) : item.detail).replace(/\s+/g, " ").trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
};

/** 项目卡片只展示最高一档，明细留给项目页。 */
const topSeverity = (project: OverviewProject) =>
  project.severity.critical
    ? "critical"
    : project.severity.high
      ? "high"
      : project.severity.medium
        ? "medium"
        : project.severity.low
          ? "low"
          : "ungraded";

const riskRank = (project: OverviewProject) =>
  project.severity.critical * 1000 + project.severity.high * 100 + project.severity.medium * 10 + project.confirmed;

/** 只列出实际存在的等级，避免出现「严重 0 · 高危 0」这种无效信息。 */
const severityNote = (severity: OverviewProject["severity"]) =>
  (
    [
      ["严重", "critical"],
      ["高危", "high"],
      ["中危", "medium"],
      ["低危", "low"],
    ] as const
  )
    .filter(([, key]) => severity[key] > 0)
    .map(([label, key]) => `${label} ${severity[key]}`)
    .join(" · ") || "暂无定级漏洞";

export function SecurityOverviewPage() {
  const ws = useWorkspace();
  const overview = ws.overview;
  const attention = overview?.attention ?? [];
  // 审核由独立模型执行，不属于「等我决定」；这里只把真正需要人操作的事项
  // 放进首屏待办，审核进度单独作为状态行出现。
  const humanAttention = attention.filter((item) => item.kind !== "review");
  const review = reviewSummary(ws.reviewFindings);
  const reviewCount = review.total;
  const humanTotal = humanAttention.reduce((sum, item) => sum + item.count, 0);
  const riskProjects = overview
    ? [...overview.projects].sort(
        (left, right) =>
          riskRank(right) - riskRank(left) || right.last_activity_at.localeCompare(left.last_activity_at),
      )
    : [];
  const loading = !overview && !ws.overviewLoading ? false : !overview;

  return (
    <section className="page page-security">
      <PageHeader
        eyebrow="WORKSPACE / SECURITY OVERVIEW"
        title="安全总览"
        description="掌握项目风险与探索进度，集中处理资产授权和运行异常。"
        actions={
          <>
            <button
              type="button"
              className="button ghost"
              onClick={() => void ws.refresh()}
              disabled={ws.overviewLoading}
            >
              <RefreshCw size={14} className={ws.overviewLoading ? "spin" : undefined} />
              刷新
            </button>
            <button type="button" className="button primary" onClick={() => ws.setModal("create")}>
              <Plus size={15} />
              新建项目
            </button>
          </>
        }
        meta={
          overview ? (
            <>
              <span className="meta-pill">
                <span
                  className="live-dot"
                  data-status={overview.totals.active_projects ? "active" : undefined}
                  aria-hidden="true"
                />
                {overview.totals.active_projects} 个项目运行中
              </span>
              <span className="meta-pill">更新于 {fmt(overview.generated_at)}</span>
              {overview.totals.pending_assets > 0 && (
                <span className="meta-pill warn">{overview.totals.pending_assets} 个资产待批准</span>
              )}
              {reviewCount > 0 && (
                <button type="button" className="meta-pill" onClick={() => ws.navigate("reviews")}>
                  {reviewCount} 条漏洞待审核
                </button>
              )}
            </>
          ) : undefined
        }
      />

      {!overview && loading && (
        <div className="overview-skeleton">
          <div className="skeleton-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="skeleton" key={index} style={{ height: 88 }} />
            ))}
          </div>
          <div className="skeleton" style={{ height: 240, marginTop: 16 }} />
        </div>
      )}

      {!overview && !loading && !ws.overviewLoading && !ws.projects.length && (
        <Card>
          <EmptyState
            icon={<ShieldAlert size={20} />}
            title="还没有可汇总的项目"
            desc="创建第一个探索项目。模型会自主规划路径、提交候选结论，风险会在这里按等级汇总。"
            action={
              <button type="button" className="button primary" onClick={() => ws.setModal("create")}>
                创建项目
              </button>
            }
          />
        </Card>
      )}

      {overview && (
        <>
          {/* 首屏主角只放人要做的事：授权资产、检查异常。审核是模型的任务。 */}
          {humanAttention.length > 0 ? (
            <section className="decide-band" aria-label="需要你处理">
              <header className="decide-band-head">
                <span className="decide-band-pip" aria-hidden="true" />
                <h2>需要你处理</h2>
                <span className="decide-band-count">{humanTotal} 项</span>
                <span className="spacer" />
                <button type="button" className="button subtle" onClick={() => ws.navigate("projects")}>
                  全部项目
                  <ArrowUpRight size={13} />
                </button>
              </header>
              <ul className="decide-list">
                {humanAttention.slice(0, 4).map((item) => (
                  <li key={`${item.project_id}:${item.kind}`}>
                    <span className="decide-kind" data-kind={item.kind}>
                      {item.kind === "assets" ? "待批准" : "需检查"}
                    </span>
                    <span className="decide-text">
                      <strong>{attentionTitle(item)}</strong>
                      <span className="decide-detail" title={item.detail}>
                        {item.project_title} · {attentionDetail(item)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`button small${item.kind === "assets" ? " primary" : ""}`}
                      onClick={() => ws.openProject(item.project_id, item.kind === "assets" ? "assets" : "tasks")}
                    >
                      {item.kind === "assets" ? "去批准" : "去检查"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <div className="overview-clear" role="status">
              <span className="overview-clear-icon" aria-hidden="true">
                <ShieldCheck size={16} />
              </span>
              <span className="overview-clear-text">
                <strong>没有需要你处理的事项</strong>
                <small>资产审批与运行异常都已清空。</small>
              </span>
            </div>
          )}

          {reviewCount > 0 && (
            <div className="auto-review-line" role="status">
              <Clock3 size={14} aria-hidden="true" />
              <span>
                <strong>{reviewCount} 条漏洞待审核</strong>
                <small>
                  {review.reviewing} 条正在审核，{review.waiting} 条等待中；查看队列了解等待原因。
                </small>
              </span>
              <span className="spacer" />
              <button type="button" className="button subtle" onClick={() => ws.navigate("reviews")}>
                查看审核队列
                <ArrowUpRight size={13} />
              </button>
            </div>
          )}

          <div className="kpi-grid">
            <Kpi
              label="已确认漏洞"
              value={overview.totals.confirmed}
              note={
                overview.totals.confirmed
                  ? `${severityNote(overview.totals.severity)}${overview.totals.informational ? ` · 信息类 ${overview.totals.informational}` : ""}`
                  : overview.totals.informational
                    ? `仅 ${overview.totals.informational} 项信息类，不计风险`
                    : "当前没有通过审核的漏洞"
              }
              tone={overview.totals.severity.critical ? "critical" : overview.totals.severity.high ? "high" : "neutral"}
              icon={<ShieldAlert size={15} />}
              onClick={() => ws.navigate("vulns")}
              hint="查看漏洞库"
            />
            <Kpi
              label="待审核"
              value={reviewCount}
              note={`${review.reviewing} 条正在审核 · ${review.waiting} 条等待中`}
              tone={reviewCount ? "accent" : "neutral"}
              icon={<Clock3 size={15} />}
              onClick={() => ws.navigate("reviews")}
              hint="查看跨项目审核队列"
            />
            <Kpi
              label="活跃项目"
              value={
                <>
                  {overview.totals.active_projects}
                  <small>/ {overview.totals.projects}</small>
                </>
              }
              note={`${overview.totals.projects - overview.totals.active_projects} 个已暂停或完成`}
              tone={overview.totals.active_projects ? "accent" : "neutral"}
              icon={<FolderKanban size={15} />}
              onClick={() => ws.navigate("projects")}
            />
            <Kpi
              label="待批准资产"
              value={overview.totals.pending_assets}
              note={`已批准 ${overview.totals.approved_assets} / 共 ${overview.totals.assets}`}
              tone={overview.totals.pending_assets ? "warn" : "neutral"}
              icon={<Globe2 size={15} />}
              onClick={() => ws.navigate("projects")}
              hint="在项目中批准测试资产"
            />
          </div>

          <div className="overview-charts">
            <Card
              title="风险分布"
              note="按当前版本已确认的漏洞统计"
              actions={
                <button type="button" className="button subtle" onClick={() => ws.navigate("vulns")}>
                  查看漏洞库
                  <ArrowUpRight size={13} />
                </button>
              }
            >
              <SeverityRows counts={overview.totals.severity} />
              <p className="chart-note">
                {overview.totals.confirmed
                  ? `共 ${overview.totals.confirmed} 项已确认漏洞；${
                      overview.totals.severity.critical + overview.totals.severity.high > 0
                        ? `严重与高危 ${overview.totals.severity.critical + overview.totals.severity.high} 项需要优先处置。`
                        : "当前没有严重或高危项。"
                    }`
                  : "尚无通过审核的漏洞。候选结论不会计入风险分布。"}
              </p>
            </Card>
            <Card title="14 天新增漏洞" note="按漏洞创建时间统计">
              {overview.trend.some((point) => point.created > 0) ? (
                <TrendChart points={overview.trend} />
              ) : (
                <EmptyState
                  compact
                  icon={<ShieldCheck size={18} />}
                  title="近 14 天没有新增漏洞"
                  desc="新确认的漏洞会按创建时间汇总在这里。"
                />
              )}
            </Card>
          </div>

          <div className="split-grid overview-lower">
            <Card
              title="优先处置"
              note="跨项目 · 已确认的严重与高危"
              actions={
                <button type="button" className="button subtle" onClick={() => ws.navigate("vulns")}>
                  漏洞库
                  <ArrowUpRight size={13} />
                </button>
              }
            >
              {overview.priority.length ? (
                overview.priority.map((finding) => (
                  <button
                    type="button"
                    className="priority-row"
                    key={`${finding.project_id}:${finding.id}`}
                    onClick={() => ws.openFinding(finding.project_id, finding.id)}
                  >
                    <SeverityBadge severity={finding.severity} />
                    <span className="priority-main">
                      <strong>{finding.title}</strong>
                      <small>
                        {finding.project_title}
                        {finding.asset_hostname ? ` · ${finding.asset_hostname}` : ""}
                        {finding.cvss_score !== null ? ` · CVSS ${finding.cvss_score.toFixed(1)}` : ""}
                      </small>
                    </span>
                    <span className="priority-time">{fromNow(finding.created_at)}</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))
              ) : (
                <EmptyState
                  compact
                  icon={<ShieldCheck size={18} />}
                  title="没有高优先级漏洞"
                  desc="审核通过的严重 / 高危漏洞会集中在这里。"
                />
              )}
            </Card>

            <Card
              title="项目风险"
              note={`${overview.projects.length} 个项目 · 按风险排序`}
              actions={
                <button type="button" className="button subtle" onClick={() => ws.navigate("projects")}>
                  全部项目
                  <ArrowUpRight size={13} />
                </button>
              }
            >
              {riskProjects.length ? (
                riskProjects.slice(0, 5).map((project) => (
                  <button
                    type="button"
                    className="priority-row"
                    key={project.id}
                    onClick={() => ws.openProject(project.id)}
                  >
                    {project.confirmed ? (
                      <SeverityBadge severity={topSeverity(project)} />
                    ) : (
                      <span className="tag">无确认</span>
                    )}
                    <span className="priority-main">
                      <strong>{project.title}</strong>
                      <small>
                        {project.confirmed} 项已确认 · {severityNote(project.severity)}
                        {project.pending_review ? ` · ${project.pending_review} 审核中` : ""}
                      </small>
                    </span>
                    <StatusPill value={project.status} />
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))
              ) : (
                <EmptyState compact title="还没有项目数据" desc="创建项目后，风险会按项目排列在这里。" />
              )}
            </Card>
          </div>

          <Card title="Token 消耗" note="近 14 天 · 全部项目" className="token-chart-card">
            {overview.usage.requests ? (
              <TokenTrendChart usage={overview.usage} />
            ) : (
              <EmptyState
                compact
                icon={<Gauge size={18} />}
                title="近 14 天没有 Token 记录"
                desc="项目开始调用模型后，这里会按天汇总输入、输出与缓存用量。"
              />
            )}
          </Card>

          <footer className="overview-foot">
            <span>
              统计口径：已确认漏洞需明确分类、当前版本审核通过、带原始证据与有效的正分影响证明；候选与信息类不计入风险。
            </span>
            <span>
              证据 {overview.totals.evidence} · 审核 {overview.totals.reviews} 次 · 流量 {overview.totals.traffic} ·
              更新于 {fmt(overview.generated_at)}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}
