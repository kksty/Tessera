import { useMemo } from "react";
import { ArrowUpRight, History, RefreshCw, Search } from "lucide-react";
import { EmptyState, PageHeader, Segmented } from "../components/ui.js";
import { fmt, locateRecord, useWorkspace } from "../workspace.js";
import { projectActivity, kindLabel, type ActivityRow } from "../project-activity.js";
import { domainStats, type DomainStats } from "../graph-summary.js";
import { blackboardIndexAt } from "../replay.js";
import { useViewState } from "../view-state.js";
import { TasksPage } from "./Tasks.js";

const viewOptions = [
  ["tasks", "任务与运行"],
  ["events", "事件时间线"],
] as const;

type TimelineView = (typeof viewOptions)[number][0];

const categoryOptions = [
  ["all", "全部进展"],
  ["milestones", "项目里程碑"],
  ["exploration", "探索推进"],
  ["findings", "发现与审核"],
  ["human", "人工操作"],
  ["delivery", "交付变化"],
  ["attention", "需要关注"],
] as const;

type Category = (typeof categoryOptions)[number][0];

const PAGE = 100;

export function TimelinePage({ initialView = "tasks" }: { initialView?: TimelineView } = {}) {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const swarm = graph.project.mode === "swarm";
  const prefix = `${graph.project.id}:timeline:`;
  const [savedView, setView] = useViewState<TimelineView>(`${prefix}view`, initialView);
  const view: TimelineView = viewOptions.some(([key]) => key === savedView) ? savedView : initialView;
  const [savedCategory, setCategory] = useViewState<Category>(`${prefix}category`, "all");
  const [all, setAll] = useViewState(`${prefix}all`, false);
  const [query, setQuery] = useViewState(`${prefix}query`, "");
  const [limit, setLimit] = useViewState(`${prefix}limit`, PAGE);

  const category: Category = categoryOptions.some(([key]) => key === savedCategory) ? savedCategory : "all";

  const rows = useMemo(() => projectActivity(ws.events, graph, all), [ws.events, graph, all]);
  const stats = useMemo(() => domainStats(graph), [graph]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          (category === "all" || row.category === category) &&
          (!needle ||
            `${row.title} ${row.detail} ${row.actor} ${row.reason} ${kindLabel(row.kind)} ${row.targets.join(" ")}`
              .toLowerCase()
              .includes(needle)),
      ),
    [rows, category, needle],
  );
  const visible = filtered.slice(0, limit);

  function targetName(id: string) {
    if (graph.findings.some((finding) => finding.id === id)) return `发现 ${id}`;
    if (graph.evidence.some((item) => item.id === id)) return `证据 ${id}`;
    if (graph.steps.some((step) => step.id === id)) return `任务 ${id}`;
    if (graph.assets.some((asset) => asset.id === id)) return `资产 ${id}`;
    return `记录 ${id}`;
  }

  function openTarget(id: string) {
    const evidence = graph.evidence.find((item) => item.id === id);
    if (evidence) {
      ws.navigate("evidence");
      void ws.showEvidence(evidence);
      return;
    }
    if (graph.assets.some((asset) => asset.id === id)) {
      ws.navigate("assets");
      return;
    }
    if (graph.findings.some((finding) => finding.id === id)) {
      // 定位前先放开风险筛选，否则目标卡片根本不在列表里。
      ws.setFindingSeverity("all");
      ws.navigate("findings", { anchor: `finding-${id}` });
      return;
    }
    locateRecord(ws, id);
  }

  /** 回放一个时刻：选中这条事件改动的第一个节点并居中；画布仍是总视图。 */
  function replayNow(row: ActivityRow) {
    const focusId = row.targets.find((id) => graph.steps.some((step) => step.id === id)) ?? row.targets[0] ?? null;
    ws.setPlaying(false);
    // 项目时间线是完整历史；黑板回放只按「图有变化」的时刻推进，停在最近一次图变化。
    const seq = ws.events[row.index]?.seq;
    const index = seq === undefined ? -1 : blackboardIndexAt(ws.boardEvents, seq);
    ws.setReplayIndex(index < 0 ? null : index);
    ws.navigate("blackboard");
    ws.clearGraphScope();
    ws.setHistoryTab("detail");
    ws.setSelected(focusId);
    if (focusId) ws.setFocus({ id: focusId, seq: Date.now() });
  }

  return (
    <section className="page page-timeline">
      <PageHeader
        eyebrow="PROJECT / TIMELINE"
        title="时间线"
        description="任务队列、运行记录与项目进展收在同一个入口：上面看还在做什么，下面按时间倒序回看每一步。"
        actions={
          <>
            {view === "events" && (
              <span className="status-pill" data-tone="accent">
                {filtered.length} 条进展
              </span>
            )}
            <button type="button" className="button" disabled={ws.refreshing} onClick={() => void ws.refresh()}>
              <RefreshCw size={13} className={ws.refreshing ? "spin" : ""} aria-hidden="true" />
              刷新
            </button>
          </>
        }
      />

      <div className="toolbar">
        <Segmented
          ariaLabel="时间线视图"
          value={view}
          onChange={setView}
          options={viewOptions.map(([key, label]) => [key, swarm && key === "tasks" ? "回合记录" : label] as const)}
        />
      </div>

      {stats.total > 0 && <DomainCoverage stats={stats} />}

      {view === "tasks" ? (
        <TasksPage embedded />
      ) : (
        <>
          <div className="toolbar timeline-toolbar">
            <Segmented
              ariaLabel="时间线分类"
              value={category}
              onChange={(next) => {
                setCategory(next);
                setLimit(PAGE);
              }}
              options={categoryOptions}
            />
            <label className="timeline-audit">
              <input
                type="checkbox"
                checked={all}
                onChange={(event) => {
                  setAll(event.target.checked);
                  setLimit(PAGE);
                }}
              />
              <span>全部事件</span>
            </label>
            <label className="search-input timeline-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="搜索时间线"
                placeholder="搜索进展、执行者或记录 ID"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE);
                }}
              />
            </label>
          </div>

          {visible.length > 0 && (
            <ol className="timeline-list">
              {visible.map((row) => (
                <li className="timeline-row" key={row.key} data-category={row.category}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div className="timeline-main">
                    <div className="timeline-head">
                      <time className="timeline-time mono" dateTime={row.time}>
                        {fmt(row.time)}
                      </time>
                      <strong className="timeline-title">{row.title}</strong>
                    </div>
                    <div className="timeline-meta">
                      <span>{row.actor}</span>
                      {all && (
                        <span className="mono">
                          {kindLabel(row.kind)} · 版本 {ws.events[row.index]?.revision ?? "—"}
                        </span>
                      )}
                    </div>
                    {row.detail && <p className="timeline-detail">{row.detail}</p>}
                    {row.reason && <p className="timeline-reason">理由：{row.reason}</p>}
                    {row.targets.length > 0 && (
                      <div className="timeline-targets">
                        {row.targets.slice(0, 8).map((id) => (
                          <button
                            type="button"
                            className="timeline-chip"
                            key={id}
                            title={id}
                            onClick={() => openTarget(id)}
                          >
                            {targetName(id)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="button ghost small timeline-replay"
                    onClick={() => replayNow(row)}
                    title="在黑板回放这条事件改动的时刻"
                  >
                    回放此刻
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}

          {!rows.length ? (
            <div className="timeline-empty">
              <EmptyState
                title="还没有项目动态"
                desc="项目开始探索后，这里会按时间顺序记录每一次推进、人工操作与结论变化。"
              />
            </div>
          ) : (
            !filtered.length && (
              <div className="timeline-empty">
                <EmptyState
                  title="没有匹配的进展"
                  desc="调整分类或搜索关键词；审计记录需要勾选「全部事件」才会显示。"
                />
              </div>
            )
          )}

          {filtered.length > 0 && (
            <div className="timeline-foot">
              <span className="timeline-count">
                已显示 {visible.length} / {filtered.length} 条
              </span>
              {filtered.length > limit && (
                <button type="button" className="button small" onClick={() => setLimit((value) => value + PAGE)}>
                  <History size={12} aria-hidden="true" />
                  继续加载 · 还有 {filtered.length - limit} 条
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 项目日志里的测试域覆盖条：任务按 test_domain 统计，空域保留 0 条以便看出缺口。 */
function DomainCoverage({ stats }: { stats: DomainStats }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <section className="timeline-domains" aria-label="测试域覆盖">
      <div className="timeline-domains-head">
        <strong>测试域覆盖</strong>
        <span>
          任务 {stats.total} · 已分类 {stats.classified}（{percent(stats.classified / stats.total)}）· 未分类{" "}
          {stats.unclassified}（{percent(stats.otherRatio)}）· 核心域 {stats.used}/{stats.coreTotal}
          {stats.crossDomain > 0 && <span title="输入事实来自其他测试域的任务数">· 跨域 {stats.crossDomain}</span>}
        </span>
      </div>
      <div className="timeline-domain-grid">
        {stats.domains.map((domain) => (
          <div
            className="timeline-domain"
            key={domain.key}
            data-domain={domain.key}
            data-empty={domain.steps ? undefined : "true"}
            title={`${domain.label}：任务 ${domain.steps} · 事实 ${domain.facts} · 发现 ${domain.findings}`}
          >
            <span className="timeline-domain-label">{domain.label}</span>
            <span className="timeline-domain-track" aria-hidden="true">
              <i
                className="timeline-domain-fill"
                style={{ width: domain.steps ? `${Math.max(domain.share * 100, 2)}%` : "0%" }}
              />
            </span>
            <span className="timeline-domain-count mono">{domain.steps}</span>
          </div>
        ))}
      </div>
      <p className="timeline-domains-note">
        只统计未删除、未丢弃的任务{stats.discarded ? `（另有 ${stats.discarded} 个已丢弃任务未计入）` : ""}
        ；事实与发现按生产任务继承测试域，未分类即没有填 test_domain 的旧任务。
      </p>
    </section>
  );
}
