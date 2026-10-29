import { useMemo } from "react";
import { ArrowRight, FolderKanban, Pause, Plus, Search, ShieldAlert, ShieldCheck, Clock3 } from "lucide-react";
import type { ProjectSummary } from "../../../../packages/protocol/src/index.js";
import { fromNow } from "../format.js";
import { Card, EmptyState, Kpi, PageHeader, Segmented, StatusPill } from "../components/ui.js";
import { ImportProject } from "../components/ImportProject.js";
import { ProjectExtras } from "../WorkbenchTools.js";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";
import { useViewState } from "../view-state.js";

const stateLine = (project: ProjectSummary) =>
  project.search_state === "reviewing"
    ? "搜索结束、审核中"
    : project.reason
      ? "模型正在决定下一步"
      : project.working_intent_count
        ? `正在探索 ${project.working_intent_count} 个任务`
        : project.status === "active"
          ? "等待新信息"
          : project.status === "stopped"
            ? "已暂停，随时可以继续"
            : "探索已结束";

/** 0 不是这个页面值得看的数字：降一档，让有内容的单元格先被看见。 */
const numCell = (value: number, suffix?: string) => (
  <td className="num" data-label={suffix} data-zero={value === 0 || undefined}>
    {value}
  </td>
);

export function ProjectsPage() {
  const ws = useWorkspace();
  const { projects } = ws;
  const [filter, setFilter] = useViewState<"all" | "active" | "stopped" | "completed">(
    "workspace:projects:filter",
    "all",
  );
  const [query, setQuery] = useViewState("workspace:projects:query", "");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (filter !== "all" && project.status !== filter) return false;
      if (needle && !`${project.title} ${project.id}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [projects, filter, query]);

  const count = (status: string) =>
    status === "all" ? projects.length : projects.filter((project) => project.status === status).length;
  const totalConfirmed = projects.reduce((sum, project) => sum + (project.confirmed_finding_count ?? 0), 0);
  const totalFindings = projects.reduce((sum, project) => sum + project.finding_count, 0);
  const totalPending = ws.reviewFindings.length;
  const totalPendingAssets = projects.reduce((sum, project) => sum + project.pending_asset_count, 0);

  return (
    <section className="page page-projects">
      <PageHeader
        eyebrow="WORKSPACE / PROJECTS"
        title="项目"
        description="每个项目是一张可回查的探索图：任务、路径、证据与结论都留在里面。"
        actions={
          <>
            <ImportProject />
            <button
              type="button"
              className="button ghost"
              disabled={!count("active") || ws.busy}
              onClick={() =>
                void ws.action(() =>
                  Promise.all(
                    projects
                      .filter((project) => project.status === "active")
                      .map((project) => api(path(project.id, "/status"), { status: "stopped" }, "PUT")),
                  ),
                )
              }
            >
              <Pause size={14} />
              暂停全部
            </button>
            <span className="page-actions-sep" aria-hidden="true" />
            <button type="button" className="button primary" onClick={() => ws.setModal("create")}>
              <Plus size={15} />
              新建项目
            </button>
          </>
        }
      />

      {/* 已确认漏洞与全部发现分开报数：项目页不再把候选当成漏洞。 */}
      <div className="kpi-grid">
        <Kpi
          label="已确认漏洞"
          value={totalConfirmed}
          note={`共 ${totalFindings} 条发现 · ${projects.length} 个项目`}
          tone={totalConfirmed ? "high" : "neutral"}
          icon={<ShieldAlert size={15} />}
          onClick={() => ws.navigate("vulns")}
          hint="查看漏洞库"
        />
        <Kpi
          label="待批准资产"
          value={totalPendingAssets}
          note="需要你授权后才进入测试范围"
          tone={totalPendingAssets ? "accent" : "neutral"}
          icon={<ShieldCheck size={15} />}
        />
        <Kpi
          label="待审核"
          value={totalPending}
          note="包含正在审核与等待中的发现"
          tone={totalPending ? "accent" : "neutral"}
          icon={<Clock3 size={15} />}
          onClick={() => ws.navigate("reviews")}
          hint="查看跨项目审核队列"
        />
        <Kpi
          label="运行中"
          value={count("active")}
          note={`共 ${projects.length} 个项目`}
          icon={<FolderKanban size={15} />}
        />
      </div>

      <div className="toolbar projects-toolbar">
        <Segmented
          ariaLabel="项目筛选"
          value={filter}
          onChange={setFilter}
          options={
            [
              ["all", `全部 ${count("all")}`],
              ["active", `运行中 ${count("active")}`],
              ["stopped", `已暂停 ${count("stopped")}`],
              ["completed", `已完成 ${count("completed")}`],
            ] as const
          }
        />
        <label className="search-input">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目名称…"
            aria-label="搜索项目"
          />
        </label>
        <span className="spacer" />
        <span className="toolbar-hint">按创建时间倒序</span>
      </div>

      {filtered.length ? (
        <div className="data-table-wrap">
          <table className="data-table projects-table">
            <thead>
              <tr>
                <th scope="col">项目</th>
                <th scope="col">状态</th>
                <th scope="col" className="num">
                  已确认
                </th>
                <th scope="col" className="num">
                  待审核
                </th>
                <th scope="col" className="num">
                  待批资产
                </th>
                <th scope="col" className="num">
                  未领取任务
                </th>
                <th scope="col">创建于</th>
                <th scope="col" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((project) => (
                <tr key={project.id}>
                  <td className="projects-name-cell">
                    <button
                      type="button"
                      className="projects-name"
                      onClick={() => ws.openProject(project.id)}
                      title={project.title}
                    >
                      {project.title}
                    </button>
                    <span className="projects-sub">
                      <span className="mono">{project.id}</span>
                      {project.mode === "swarm" && (
                        <span className="tag" title="平等执行者编排：无决策者、无 Step">
                          Swarm
                        </span>
                      )}
                      <span className="projects-state">{stateLine(project)}</span>
                    </span>
                  </td>
                  <td className="projects-status-cell">
                    <StatusPill
                      value={project.status}
                      label={project.search_state === "reviewing" ? "搜索结束、审核中" : undefined}
                    />
                  </td>
                  <td
                    className="num"
                    data-label="已确认"
                    data-zero={(project.confirmed_finding_count ?? 0) === 0 || undefined}
                  >
                    {project.confirmed_finding_count ?? 0}
                    {project.finding_count > (project.confirmed_finding_count ?? 0) && (
                      <span className="cell-sub">共 {project.finding_count} 条发现</span>
                    )}
                  </td>
                  {numCell(project.review_pending_count, "待审核")}
                  {numCell(project.pending_asset_count, "待批资产")}
                  {numCell(project.unclaimed_intent_count, "未领取任务")}
                  <td className="projects-time">{fromNow(project.created_at)}</td>
                  <td className="projects-row-actions">
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => ws.openProject(project.id)}
                      aria-label={`打开项目 ${project.title}`}
                    >
                      打开
                      <ArrowRight size={12} />
                    </button>
                    <ProjectExtras
                      compact
                      project={project}
                      afterChange={ws.action}
                      onRemoved={() => void ws.refresh()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : projects.length ? (
        <Card>
          <EmptyState
            icon={<FolderKanban size={20} />}
            title="没有匹配的项目"
            desc="调整筛选条件或搜索关键词。"
            action={
              <button
                type="button"
                className="button"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                清除筛选
              </button>
            }
          />
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="从第一张黑板开始"
            desc="填写指定站点与目标，模型将自主寻找探索路径；发现的子域名与候选结论等你批准或审核。"
            action={
              <button type="button" className="button primary" onClick={() => ws.setModal("create")}>
                创建项目
              </button>
            }
          />
        </Card>
      )}
    </section>
  );
}
