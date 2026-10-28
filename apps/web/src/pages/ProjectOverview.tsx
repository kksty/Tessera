import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  CheckCheck,
  Clock3,
  FileText,
  GitBranch,
  Globe2,
  Play,
  Route,
  ShieldAlert,
  ShieldCheck,
  Timer,
  X,
} from "lucide-react";
import { stepAssets } from "../../../../packages/protocol/src/asset-scope.js";
import { searchState } from "../../../../packages/protocol/src/planning.js";
import { pendingReviews } from "../../../../packages/protocol/src/review-scheduling.js";
import { api, path } from "../api.js";
import { coldNodes, coldState } from "../coldness.js";
import { completionSnapshot } from "../completion-view.js";
import { duration, fmt, fmtTime, severityOrder } from "../format.js";
import {
  confirmedInformational,
  confirmedVulnerability,
  projectActivity,
  projectRuntime,
  severityLevels,
} from "../project-activity.js";
import { SeverityBar } from "../components/charts.js";
import { CoverageTable } from "../components/CoverageTable.js";
import { LeadList } from "../components/LeadList.js";
import { ToolLeaderboard } from "../components/ToolLeaderboard.js";
import { Card, EmptyState, Kpi, Modal, SeverityBadge, StatusPill } from "../components/ui.js";
import { ProjectHeader } from "../components/Shell.js";
import { StepDecision } from "../components/StepDecision.js";
import { locateRecord, readableError, stepState, useWorkspace } from "../workspace.js";

export function ProjectOverviewPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const project = graph.project;
  // A control-plane outage is not a task failure: it backs off and retries while
  // the project stays active. Surfacing it as "任务失败" would invite a manual stop.
  const infra =
    project.last_failure_kind === "infrastructure" && (project.infra_failures ?? 0) > 0
      ? { count: project.infra_failures!, at: project.infra_retry_at }
      : undefined;
  const entry = coldState(graph);
  const [closing, setClosing] = useState<(typeof graph.steps)[number] | null>(null);
  const [scopeDraft, setScopeDraft] = useState<{ goal: string; origin: string } | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const errorText = project.last_error ? readableError(project.last_error) : "";
  const errorIsTimeout = /timeout|aborted/i.test(errorText);
  const errorSummary = errorIsTimeout
    ? "最近一次执行超时，自动重试已停止；任务、证据与已有结论都已保留。"
    : errorText.length > 160
      ? `${errorText.slice(0, 160).trimEnd()}…`
      : errorText;
  const hasErrorDetail = errorIsTimeout || errorText.length > 160;

  const pendingAssets = graph.assets.filter((asset) => asset.approval === "pending");
  const pending = pendingReviews(graph).map((row) => row.finding);
  const reviewing = pending.filter((finding) => finding.review_worker).length;
  const confirmed = graph.findings.filter((f) => confirmedVulnerability(f, graph));
  const informational = graph.findings.filter((f) => confirmedInformational(f, graph)).length;
  const running = graph.steps.filter((step) => stepState(step) === "running");
  const attention = graph.steps.filter((step) => ["failed", "needs_attention"].includes(stepState(step)));
  const awaiting = graph.steps.filter((step) => stepState(step) === "executed");
  const recent = useMemo(() => projectActivity(ws.events, graph).slice(0, 6), [ws.events, graph]);
  const highlights = confirmed
    .filter((finding) => finding.severity === "critical" || finding.severity === "high")
    .sort((left, right) => Number(right.severity === "critical") - Number(left.severity === "critical"))
    .slice(0, 5);
  const completed = graph.steps.filter((step) => step.concluded_at).length;
  const approved = graph.assets.filter((asset) => asset.approval === "approved");
  const covered = approved.filter((asset) =>
    graph.steps.some((step) => step.concluded_at && stepAssets(graph, step).includes(asset.id)),
  ).length;
  const leads = graph.leads ?? [];
  const openLeads = leads.filter((lead) => lead.status === "open");
  const completion = completionSnapshot(graph);
  const showCoverage = completion.pending || project.status === "completed";

  const runtime = projectRuntime(ws.events, project.created_at);
  const goal = graph.goals.find((item) => item.id === "goal")?.description || "尚未记录项目目标";
  const goalIsLong = goal.length > 170;
  const goalPreview = useMemo(() => {
    if (!goalIsLong) return goal;
    const cut = goal.slice(0, 170);
    const boundary = Math.max(
      cut.lastIndexOf("。"),
      cut.lastIndexOf("；"),
      cut.lastIndexOf(". "),
      cut.lastIndexOf("; "),
    );
    return `${(boundary > 80 ? cut.slice(0, boundary + 1) : cut).trimEnd()}…`;
  }, [goal, goalIsLong]);
  const origin = graph.facts.find((item) => item.id === "origin")?.description || "";
  const severityCounts = Object.fromEntries(
    severityOrder.map((key) => [key, confirmed.filter((finding) => (finding.severity || "ungraded") === key).length]),
  ) as Record<(typeof severityOrder)[number], number>;
  const severitySummary =
    (
      [
        ["严重", severityCounts.critical],
        ["高危", severityCounts.high],
        ["中危", severityCounts.medium],
        ["低危", severityCounts.low],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)
      .join(" · ") || "暂无定级漏洞";
  const confirmedNote =
    confirmed.length === 0
      ? informational
        ? `仅 ${informational} 项信息类，不计风险`
        : "暂无定级漏洞"
      : `${severitySummary}${informational ? ` · 信息类 ${informational}` : ""}`;
  const todoCount = pendingAssets.length + attention.length + awaiting.length;

  function openSeverity(value: string) {
    ws.setFindingSeverity(value);
    ws.navigate("findings", { top: true });
  }

  async function saveScope(resume: boolean) {
    if (!scopeDraft) return;
    const nextGoal = scopeDraft.goal.trim();
    const nextOrigin = scopeDraft.origin.trim();
    if (!nextGoal || !nextOrigin) return;
    const wantsResume = resume && project.status !== "active";
    let ok = true;
    // Save the origin first: it changes the authorized scope, and the goal
    // rewrite then notices the project is already running again.
    if (nextOrigin !== origin)
      ok = await ws.action(() =>
        api(path(project.id, "/origin"), { description: nextOrigin, resume: wantsResume }, "PUT"),
      );
    if (ok && (nextGoal !== goal || (wantsResume && nextOrigin === origin)))
      ok = await ws.action(() =>
        api(path(project.id, "/goals/goal"), { description: nextGoal, resume: wantsResume }, "PUT"),
      );
    if (ok) setScopeDraft(null);
  }

  return (
    <section className="page page-project-overview">
      <ProjectHeader
        eyebrow="PROJECT / OVERVIEW"
        title={project.title}
        description={
          <>
            {goalExpanded ? goal : goalPreview}
            {goalIsLong && (
              <button type="button" className="inline-toggle" onClick={() => setGoalExpanded((value) => !value)}>
                {goalExpanded ? "收起目标" : "展开完整目标"}
              </button>
            )}
          </>
        }
        actions={
          <>
            <button type="button" className="button ghost" onClick={() => ws.navigate("timeline")}>
              <Clock3 size={14} />
              时间线
            </button>
            <button type="button" className="button primary" onClick={() => ws.navigate("blackboard")}>
              <GitBranch size={15} />
              打开黑板
            </button>
          </>
        }
      />

      <div className="page-meta project-meta">
        <StatusPill
          value={project.status}
          label={
            searchState(graph) === "reviewing"
              ? "搜索结束、审核中"
              : project.status === "active"
                ? "探索进行中"
                : undefined
          }
        />
        <span className="meta-pill">
          <Timer size={13} aria-hidden="true" />
          运行 {duration(runtime)}
        </span>
        <span className="meta-pill">
          <CalendarDays size={13} aria-hidden="true" />
          创建于 {fmt(project.created_at)}
        </span>
        <span className="meta-pill" title="入口预算：热 Facts/Findings 数量 / 上限 · 冷记录 · 入口字符">
          <GitBranch size={13} aria-hidden="true" />
          {entry.disabled
            ? "冷热已关闭"
            : `热 ${entry.hot.nodes}/${entry.limit} · 冷 ${coldNodes(graph).length}${
                entry.char_limit
                  ? ` · ${Math.round(entry.hot.chars / 1000)}k/${Math.round(entry.char_limit / 1000)}k 字符`
                  : ""
              }`}
        </span>
        <button
          type="button"
          className="button subtle"
          disabled={ws.busy || project.status === "completed"}
          onClick={() => setScopeDraft({ goal, origin })}
          title={
            project.status === "completed"
              ? "项目已完成；先继续评估，再改写目标或起点"
              : "下一轮 Decide 直接读取；旧文本保留在事件流里"
          }
        >
          改写目标与起点
        </button>
      </div>

      {infra && (
        <div className="banner warn">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="banner-text" title={errorText}>
            控制面故障，第 {infra.count} 次退避重试{infra.at ? `（下次 ${fmtTime(infra.at)}）` : ""}
            ：项目保持运行，不会因该故障暂停；恢复后自动继续，未提交的观测仍保留。
            {errorText ? `最近错误：${errorSummary}` : ""}
          </span>
          <button type="button" className="button ghost small" onClick={() => ws.navigate("tasks")}>
            查看运行
          </button>
        </div>
      )}

      {project.last_error && !errorDismissed && !infra && (
        <div className="banner warn">
          <AlertTriangle size={15} aria-hidden="true" />
          <span className="banner-text" title={errorText}>
            {errorExpanded ? errorText : errorSummary}
          </span>
          {hasErrorDetail && (
            <button type="button" className="button ghost small" onClick={() => setErrorExpanded((value) => !value)}>
              {errorExpanded ? "收起" : "展开详情"}
            </button>
          )}
          <button type="button" className="button ghost small" onClick={() => ws.navigate("tasks")}>
            查看运行
          </button>
          <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setErrorDismissed(true)}>
            <X size={13} />
          </button>
        </div>
      )}

      {todoCount ? (
        <Card
          className="todo-card"
          title="需要你处理"
          note={`${todoCount} 项`}
          actions={<span className="quiet">批准资产、关闭任务、检查异常</span>}
        >
          {pendingAssets.slice(0, 4).map((asset) => (
            <div className="todo-row" key={asset.id}>
              <span className="todo-icon">
                <Globe2 size={15} />
              </span>
              <div className="todo-main">
                <strong>{asset.hostname}</strong>
                <small>待批准测试 · {asset.source}</small>
              </div>
              <button
                type="button"
                className="button small"
                disabled={ws.busy}
                onClick={() => void ws.action(() => api(path(project.id, "/assets/approve"), { ids: [asset.id] }))}
              >
                批准测试
              </button>
            </div>
          ))}
          {awaiting.slice(0, 4).map((step) => (
            <div className="todo-row" key={step.id}>
              <span className="todo-icon">
                <CheckCheck size={15} />
              </span>
              <div className="todo-main">
                <strong>{step.description}</strong>
                <small>执行结束，等待决策者判断是否关闭</small>
              </div>
              <button type="button" className="button ghost small" onClick={() => locateRecord(ws, step.id)}>
                查看任务
              </button>
              <button type="button" className="button small" disabled={ws.busy} onClick={() => setClosing(step)}>
                关闭
              </button>
            </div>
          ))}
          {attention.slice(0, 4).map((step) => (
            <div className="todo-row" key={step.id}>
              <span className="todo-icon danger">
                <AlertTriangle size={15} />
              </span>
              <div className="todo-main">
                <strong>{step.description}</strong>
                <small>{stepState(step) === "needs_attention" ? "外部操作结果待人工确认" : "执行失败，等待处理"}</small>
              </div>
              <button type="button" className="button small" onClick={() => locateRecord(ws, step.id)}>
                检查任务
              </button>
              {stepState(step) === "needs_attention" && (
                <button type="button" className="button small danger" onClick={() => ws.navigate("retry")}>
                  人工重试
                </button>
              )}
            </div>
          ))}
        </Card>
      ) : (
        <div className="overview-clear" role="status">
          <span className="overview-clear-icon" aria-hidden="true">
            <CheckCheck size={16} />
          </span>
          <span className="overview-clear-text">
            <strong>没有需要你处理的事项</strong>
            <small>资产批准、任务关闭与运行异常都已清空。</small>
          </span>
        </div>
      )}

      {pending.length > 0 && (
        <div className="auto-review-line" role="status">
          <CheckCheck size={14} aria-hidden="true" />
          <span>
            <strong>{pending.length} 条发现待审核</strong>
            <small>
              {reviewing} 条正在审核，{pending.length - reviewing} 条等待中；通过审核的漏洞计入风险统计。
            </small>
          </span>
          <span className="spacer" />
          <button type="button" className="button subtle" onClick={() => ws.navigate("review")}>
            查看进度
          </button>
        </div>
      )}

      <div className="kpi-grid">
        <Kpi
          label="已确认漏洞"
          value={confirmed.length}
          note={confirmedNote}
          tone={severityCounts.critical ? "critical" : severityCounts.high ? "high" : "neutral"}
          icon={<ShieldAlert size={15} />}
          onClick={() => openSeverity("confirmed")}
        />
        <Kpi
          label="待审核"
          value={pending.length}
          note={`${reviewing} 条正在审核 · ${pending.length - reviewing} 条等待中`}
          tone={pending.length ? "accent" : "neutral"}
          icon={<ShieldCheck size={15} />}
          onClick={() => ws.navigate("review")}
        />
        <Kpi
          label="进行中任务"
          value={running.length}
          note={`${graph.steps.length - completed} 个未关闭 / 共 ${graph.steps.length}`}
          icon={<Play size={15} />}
          onClick={() => ws.navigate("tasks")}
        />
        <Kpi
          label="已批准资产"
          value={approved.length}
          note={`${covered} 个已进入任务`}
          icon={<Globe2 size={15} />}
          onClick={() => ws.navigate("assets")}
        />
        <Kpi
          label="证据"
          value={graph.evidence.length}
          note={`${graph.reviews.length} 次审核 · ${graph.facts.length} 条事实`}
          icon={<FileText size={15} />}
        />
      </div>

      <div className="project-overview-grid">
        <Card
          title="风险概况"
          note="仅统计当前版本审核通过的漏洞"
          actions={
            <button type="button" className="button subtle" onClick={() => openSeverity("confirmed")}>
              查看全部
              <ArrowUpRight size={13} />
            </button>
          }
        >
          {confirmed.length ? (
            <>
              <SeverityBar counts={severityCounts} height={10} />
              <div className="risk-tiles">
                {severityLevels.map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className="risk-tile"
                    data-severity={key}
                    onClick={() => openSeverity(key)}
                    disabled={!severityCounts[key as (typeof severityOrder)[number]]}
                  >
                    <i aria-hidden="true" />
                    <span>{label}</span>
                    <strong>{severityCounts[key as (typeof severityOrder)[number]]}</strong>
                  </button>
                ))}
              </div>
              <div className="risk-foot">
                <button type="button" className="button ghost small" onClick={() => openSeverity("confirmed")}>
                  已确认 {confirmed.length} 项
                  <ArrowUpRight size={12} />
                </button>
                <button type="button" className="button ghost small" onClick={() => ws.navigate("review")}>
                  待审核 {pending.length} 项
                  <ArrowUpRight size={12} />
                </button>
                <span className="quiet">同一发现按当前有效版本计一次；未定级单列。</span>
              </div>
            </>
          ) : (
            <EmptyState
              compact
              icon={<ShieldCheck size={18} />}
              title="暂无已确认漏洞"
              desc={
                pending.length
                  ? `${pending.length} 条发现待审核；通过审核的漏洞才会进入风险分布。`
                  : "审核通过的漏洞会按等级显示在这里。"
              }
            />
          )}
        </Card>

        <Card title="任务状态" note={`${completed} 已关闭 · ${graph.steps.length - completed} 未关闭`}>
          <div className="progress-block">
            <div className="progress-head">
              <span>已关闭任务</span>
              <strong>
                {completed} / {graph.steps.length}
              </strong>
            </div>
          </div>
          <div className="progress-block">
            <div className="progress-head">
              <span>已进入任务的批准资产</span>
              <strong>
                {covered} / {approved.length}
              </strong>
            </div>
          </div>
          {graph.hints.some((hint) => !hint.withdrawn_at && !hint.resolved) && (
            <p className="quiet">
              {graph.hints.filter((hint) => !hint.withdrawn_at && !hint.resolved).length} 条提示待处置
            </p>
          )}
          {openLeads.length > 0 && (
            <p className="quiet">
              {openLeads.length} 个 open lead，完成项目前需处置
              <button
                type="button"
                className="inline-toggle"
                onClick={() => document.getElementById("overview-leads")?.scrollIntoView({ block: "start" })}
              >
                查看明细
              </button>
            </p>
          )}
          {showCoverage && (
            <p className="quiet">
              {completion.entries.length ? `已记录 ${completion.entries.length} 项覆盖处置` : "完成时未记录逐项处置"}
              {completion.entries.length > 0 && (
                <button
                  type="button"
                  className="inline-toggle"
                  onClick={() => document.getElementById("overview-coverage")?.scrollIntoView({ block: "start" })}
                >
                  查看覆盖表
                </button>
              )}
            </p>
          )}
          <div className="explore-state">
            {project.reason ? (
              <div className="explore-line">
                <Activity size={14} aria-hidden="true" />
                <span>正在分析下一步探索方向</span>
                <span className="tag mono">{project.reason.worker}</span>
              </div>
            ) : running.length ? (
              running.slice(0, 3).map((step) => (
                <button
                  type="button"
                  key={step.id}
                  className="explore-line clickable"
                  onClick={() => locateRecord(ws, step.id)}
                >
                  <Play size={13} aria-hidden="true" />
                  <span className="truncate">{step.description}</span>
                  <span className="tag mono">{step.id}</span>
                </button>
              ))
            ) : (
              <p className="quiet explore-quiet">
                {project.status === "stopped"
                  ? "项目已暂停，任务与证据已保留。"
                  : project.status === "completed"
                    ? "探索已结束，可回查结论和证据。"
                    : project.pending_completion
                      ? "搜索结束、审核中。当前发现审核结束后完成交付。"
                      : "当前没有执行中的任务。"}
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="split-grid">
        <Card
          title="重点漏洞"
          note="已确认的严重与高危"
          actions={
            <button type="button" className="button subtle" onClick={() => openSeverity("confirmed")}>
              全部
              <ArrowUpRight size={13} />
            </button>
          }
        >
          {highlights.length ? (
            highlights.map((finding) => (
              <button
                type="button"
                className="priority-row"
                key={finding.id}
                onClick={() => {
                  openSeverity(finding.severity || "ungraded");
                  requestAnimationFrame(() =>
                    document.getElementById(`finding-${finding.id}`)?.scrollIntoView({ block: "center" }),
                  );
                }}
              >
                <SeverityBadge severity={finding.severity} />
                <span className="priority-main">
                  <strong>{finding.title}</strong>
                  <small>
                    {graph.assets.find((asset) => asset.id === finding.asset_id)?.hostname || "影响资产未标注"}
                    {finding.cvss ? ` · CVSS ${finding.cvss.score.toFixed(1)}` : ""}
                  </small>
                </span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            ))
          ) : (
            <EmptyState
              compact
              icon={<ShieldCheck size={18} />}
              title="没有严重或高危漏洞"
              desc="审核通过的严重 / 高危结论会在这里置顶。"
            />
          )}
        </Card>

        <Card
          title="最近动态"
          actions={
            <button type="button" className="button subtle" onClick={() => ws.navigate("timeline")}>
              完整时间线
              <ArrowUpRight size={13} />
            </button>
          }
        >
          {recent.length ? (
            recent.map((row) => (
              <div className="activity-row" key={row.key}>
                <span className="activity-dot" aria-hidden="true" />
                <div className="activity-main">
                  <strong>{row.title}</strong>
                  <small>
                    {fmt(row.time)} · {row.actor}
                  </small>
                  {row.detail && <p>{row.detail}</p>}
                </div>
              </div>
            ))
          ) : (
            <EmptyState compact title="还没有项目动态" desc="模型开始探索后，进展会出现在这里。" />
          )}
        </Card>
      </div>

      <ToolLeaderboard graph={graph} />

      {leads.length > 0 && (
        <Card
          id="overview-leads"
          className="overview-ledger"
          title="探索线索"
          note={`${openLeads.length} 个待处置 · ${leads.filter((lead) => lead.status === "converted").length} 已转任务 · ${leads.filter((lead) => lead.status === "waived").length} 已豁免`}
        >
          <LeadList leads={leads} steps={graph.steps} />
        </Card>
      )}

      {showCoverage && (
        <Card
          id="overview-coverage"
          className="overview-coverage"
          title="完成覆盖"
          note={
            completion.pending
              ? "完成提案已提交：逐 surface 处置等待审核与关闭条件满足"
              : completion.step?.completion
                ? `完成于 ${fmt(completion.step.concluded_at)}，记录保留在完成任务 ${completion.step.id}`
                : "历史项目：完成时未记录逐项处置"
          }
        >
          <CoverageTable graph={graph} entries={completion.entries} />
          {!completion.pending && !completion.step?.completion && (
            <p className="quiet overview-coverage-note">
              该项目完成时尚未强制记录覆盖表；上表由当前图的事实提取，处置状态为「未登记」。原始完成提交仍可在运行记录中回查。
            </p>
          )}
        </Card>
      )}

      {closing && <StepDecision step={closing} onClose={() => setClosing(null)} onDone={() => setClosing(null)} />}

      {scopeDraft && (
        <Modal
          label="改写项目目标与起点"
          title="改写项目目标与起点"
          onClose={() => setScopeDraft(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setScopeDraft(null)}>
                取消
              </button>
              {project.status !== "active" && (
                <button
                  type="button"
                  className="button"
                  disabled={ws.busy || !scopeDraft.goal.trim() || !scopeDraft.origin.trim()}
                  onClick={() => void saveScope(true)}
                >
                  保存并继续
                </button>
              )}
              <button
                type="button"
                className="button primary"
                disabled={ws.busy || !scopeDraft.goal.trim() || !scopeDraft.origin.trim()}
                onClick={() => void saveScope(false)}
              >
                保存
              </button>
            </>
          }
        >
          <p className="quiet">
            下一轮 Decide 立即读取新文本；旧值保留在事件流里，已有报告只会标记过期，不会被改写。
            {project.status !== "active" && "项目当前已暂停：选择「保存并继续」会恢复运行并重新规划。"}
          </p>
          <label className="field">
            <span className="field-label">项目起点（范围授权）</span>
            <textarea
              value={scopeDraft.origin}
              onChange={(event) => setScopeDraft({ ...scopeDraft, origin: event.target.value })}
              rows={2}
              autoFocus
            />
            <span className="field-hint">
              起点即范围：会按新主机名登记或复用资产；未开始的、源于旧起点的任务会被停止，已产生的证据与发现保留。
            </span>
          </label>
          <label className="field">
            <span className="field-label">项目目标</span>
            <textarea
              value={scopeDraft.goal}
              onChange={(event) => setScopeDraft({ ...scopeDraft, goal: event.target.value })}
              rows={4}
            />
            <span className="field-hint">
              已关闭的任务保留历史；旧计划不会继续落地，由下一轮 Decide 按新目标重新规划。
            </span>
          </label>
        </Modal>
      )}
    </section>
  );
}
