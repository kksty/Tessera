import { useMemo } from "react";
import { ArrowUpRight, ClipboardCheck, Clock3, RefreshCw, Search } from "lucide-react";
import { Card, EmptyState, Kpi, PageHeader, Segmented, SeverityBadge } from "../components/ui.js";
import { fromNow } from "../format.js";
import { reviewGateLabels, reviewQueue, reviewSummary } from "../review-queue.js";
import { useViewState } from "../view-state.js";
import { useWorkspace } from "../workspace.js";
import { FindingKindBadge } from "../components/FindingKindBadge.js";
import { ReauditButton } from "../components/ReauditButton.js";

type Filter = "all" | "reviewing" | "waiting";
const PAGE_SIZE = 30;

export function ReviewsPage() {
  const ws = useWorkspace();
  const [filter, setFilter] = useViewState<Filter>("workspace:reviews:filter", "all");
  const [query, setQuery] = useViewState("workspace:reviews:query", "");
  const [project, setProject] = useViewState("workspace:reviews:project", "all");
  const [limit, setLimit] = useViewState("workspace:reviews:limit", PAGE_SIZE);
  const summary = reviewSummary(ws.reviewFindings);
  const queue = useMemo(() => reviewQueue(ws.reviewFindings), [ws.reviewFindings]);
  const projects = useMemo(
    () => [...new Map(queue.map((finding) => [finding.project_id, finding.project_title])).entries()],
    [queue],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return queue
      .filter(
        (finding) =>
          (filter === "all" || (filter === "reviewing") === (finding.review_gate === "reviewing")) &&
          (project === "all" || project === finding.project_id) &&
          (!needle || `${finding.title} ${finding.id} ${finding.project_title}`.toLowerCase().includes(needle)),
      )
      .sort(
        (left, right) =>
          Number(right.review_gate === "reviewing") - Number(left.review_gate === "reviewing") ||
          left.created_at.localeCompare(right.created_at),
      );
  }, [queue, filter, project, query]);
  const reset = () => {
    setFilter("all");
    setProject("all");
    setQuery("");
    setLimit(PAGE_SIZE);
  };
  // 已完成/暂停的项目不会自动领取审核。把仍卡在 inactive 的项目单独列出来，
  // 提供一次只做复核的入口；否则用户只能看到「项目已暂停或完成」却没处点。
  const stalled = useMemo(() => {
    const byProject = new Map<string, { title: string; count: number; legacy: number }>();
    for (const finding of queue) {
      if (finding.review_gate !== "inactive") continue;
      const row = byProject.get(finding.project_id) ?? { title: finding.project_title, count: 0, legacy: 0 };
      row.count++;
      if (finding.classification_review_required) row.legacy++;
      byProject.set(finding.project_id, row);
    }
    return [...byProject.entries()];
  }, [queue]);
  const stalledCount = stalled.reduce((sum, [, row]) => sum + row.count, 0);
  const stalledLegacy = stalled.reduce((sum, [, row]) => sum + row.legacy, 0);

  return (
    <section className="page page-reviews">
      <PageHeader
        title="审核队列"
        description="跨项目查看尚未完成审核的发现。正在审核与等待中的发现分别统计，通过审核的漏洞进入漏洞库。"
        actions={
          <button type="button" className="button" disabled={ws.refreshing} onClick={() => void ws.refresh()}>
            <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} />
            刷新
          </button>
        }
      />
      {stalled.length > 0 && (
        <section className="review-reaudit" aria-label="待重新审核">
          <div className="review-reaudit-copy">
            <strong>{stalledCount} 条发现卡在已完成或暂停的项目中，审核模型无法自动领取</strong>
            <p>
              {stalledLegacy > 0
                ? `其中 ${stalledLegacy} 条是历史结论，需要按当前分类与证据规则重新审核；通过前不计入已确认漏洞与趋势。`
                : "重新审核只处理待审发现，不会重新规划或执行探索。"}
            </p>
          </div>
          <div className="review-reaudit-actions">
            {stalled.map(([projectId, row]) => (
              <ReauditButton
                key={projectId}
                projectId={projectId}
                label={`重新审核 ${row.title}`}
                onStarted={() => ws.openProject(projectId, "review")}
              />
            ))}
          </div>
        </section>
      )}
      <div className="kpi-grid">
        <Kpi label="待审核合计" value={summary.total} note="当前版本尚未完成审核" icon={<ClipboardCheck size={16} />} />
        <Kpi
          label="正在审核"
          value={summary.reviewing}
          note="已由审核模型领取"
          tone={summary.reviewing ? "accent" : "neutral"}
          icon={<RefreshCw size={16} />}
        />
        <Kpi label="等待中" value={summary.waiting} note="等待领取或满足审核条件" icon={<Clock3 size={16} />} />
      </div>
      <div className="toolbar reviews-toolbar">
        <Segmented
          ariaLabel="审核队列筛选"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setLimit(PAGE_SIZE);
          }}
          options={
            [
              ["all", `全部 ${summary.total}`],
              ["reviewing", `正在审核 ${summary.reviewing}`],
              ["waiting", `等待中 ${summary.waiting}`],
            ] as const
          }
        />
        <label className="search-input">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索待审核发现"
            placeholder="搜索发现或项目…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </label>
        <select
          aria-label="筛选审核项目"
          value={project}
          onChange={(event) => {
            setProject(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        >
          <option value="all">全部项目</option>
          {projects.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      </div>
      <Card title="待审核发现" note={`${filtered.length} 条`} flush>
        {filtered.length ? (
          <>
            <div className="workspace-review-list">
              {filtered.slice(0, limit).map((finding) => (
                <article className="workspace-review-row" key={`${finding.project_id}:${finding.id}`}>
                  <div className="workspace-review-main">
                    <div className="workspace-review-meta">
                      {finding.kind === "vulnerability" && <FindingKindBadge kind={finding.kind} />}
                      <span
                        className="status-pill"
                        data-tone={finding.review_gate === "reviewing" ? "accent" : "neutral"}
                      >
                        {finding.review_gate ? reviewGateLabels[finding.review_gate] : "待审核"}
                      </span>
                      {finding.kind !== "informational" && <SeverityBadge severity={finding.severity} prefix="初评" />}
                      <span className="mono muted">{finding.id}</span>
                    </div>
                    <button
                      type="button"
                      className="workspace-review-title"
                      onClick={() => ws.openFinding(finding.project_id, finding.id)}
                    >
                      {finding.title}
                    </button>
                    <p className="workspace-review-project">
                      {finding.project_title} · 创建于 {fromNow(finding.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => ws.openProject(finding.project_id, "review")}
                    aria-label={`查看 ${finding.project_title} 的审核进度`}
                  >
                    查看进度
                    <ArrowUpRight size={13} />
                  </button>
                </article>
              ))}
            </div>
            {filtered.length > limit && (
              <div className="review-load-more">
                <button type="button" className="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
                  加载更多（剩余 {filtered.length - limit} 条）
                </button>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={<ClipboardCheck size={22} />}
            title={queue.length ? "没有匹配的待审核发现" : "暂无待审核发现"}
            desc={queue.length ? "调整筛选条件，或搜索其他发现与项目。" : "新的候选发现和修订后的发现会出现在这里。"}
            action={
              queue.length ? (
                <button type="button" className="button" onClick={reset}>
                  清除筛选
                </button>
              ) : undefined
            }
          />
        )}
      </Card>
    </section>
  );
}
