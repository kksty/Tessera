import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CircleCheckBig,
  Clock3,
  FileText,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { Evidence, Run, Step } from "../../../../packages/protocol/src/index.js";
import { unmetDependencies } from "../../../../packages/protocol/src/step-chain.js";
import { Badge, EmptyState, Kpi, PageHeader, Segmented, Tabs } from "../components/ui.js";
import { RunHistory } from "../components/RunHistory.js";
import { StepDecision } from "../components/StepDecision.js";
import { fromNow } from "../format.js";
import { fmt, locateRecord, readableError, stepState, useWorkspace } from "../workspace.js";
import { DEFAULT_RUN_LIMIT, RUN_LIMITS, unsettledRun } from "../run-state.js";
import { useRuns } from "../runs.js";
import { prettyText } from "../text.js";
import { useViewState } from "../view-state.js";

type TaskTab = "list" | "runs";
type StateFilter = "all" | "open" | "running" | "executed" | "attention" | "done";

const TABS: readonly (readonly [TaskTab, string])[] = [
  ["list", "任务列表"],
  ["runs", "运行记录"],
];

const FILTERS: readonly (readonly [StateFilter, string])[] = [
  ["all", "全部"],
  ["open", "待领取"],
  ["running", "执行中"],
  ["executed", "待关闭"],
  ["attention", "需关注"],
  ["done", "已完成"],
];

/** 一屏最多渲染的行数；超出后用「显示更多」继续展开，避免长队列冻结页面。 */
const PAGE_SIZE = 60;

const isFilter = (value: string): value is StateFilter => FILTERS.some(([key]) => key === value);
const isRunLimit = (value: number): boolean => (RUN_LIMITS as readonly number[]).includes(value);

function isAttention(step: Step) {
  const state = stepState(step);
  return state === "failed" || state === "needs_attention";
}

function matchesFilter(step: Step, filter: StateFilter) {
  if (filter === "all") return true;
  if (filter === "attention") return isAttention(step);
  return stepState(step) === filter;
}

function countOf(filter: StateFilter, steps: Step[]) {
  if (filter === "all") return steps.length;
  return steps.filter((step) => matchesFilter(step, filter)).length;
}

interface StepEvidence {
  count: number;
  latest: Evidence;
}

export function TasksPage({ embedded = false }: { embedded?: boolean } = {}) {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = graph.project.id;
  const [savedTab, setSavedTab] = useViewState<TaskTab>(`${projectId}:tasks:view`, "list");
  const [savedFilter, setFilter] = useViewState<string>(`${projectId}:tasks:state`, "all");
  const [savedLimit, setRunLimit] = useViewState<number>(`${projectId}:runs:limit`, DEFAULT_RUN_LIMIT);
  const tab: TaskTab = savedTab === "runs" ? "runs" : "list";
  const filter: StateFilter = isFilter(savedFilter) ? savedFilter : "all";
  const runLimit = isRunLimit(savedLimit) ? savedLimit : DEFAULT_RUN_LIMIT;
  const { runs, error: runsError } = useRuns(projectId, runLimit);

  // 一条 needs_attention 运行只要还没结案，就仍然是“需关注”，即使它的任务行
  // 因为状态优先级（例如已执行完待关闭）没有显示成需人工检查。
  const orphanRuns = useMemo(() => {
    const byId = new Map(graph.steps.map((step) => [step.id, step]));
    return runs.filter((run) => {
      const step = run.node_id ? byId.get(run.node_id) : undefined;
      return unsettledRun(run, step) && !isAttention(step!);
    });
  }, [runs, graph.steps]);

  const counts = useMemo(() => {
    const states = graph.steps.map(stepState);
    const steps = states.filter((state) => state === "failed" || state === "needs_attention").length;
    return {
      all: states.length,
      running: states.filter((state) => state === "running").length,
      executed: states.filter((state) => state === "executed").length,
      attention: steps + orphanRuns.length,
      done: states.filter((state) => state === "done").length,
      open: states.filter((state) => state === "open").length,
    };
  }, [graph.steps, orphanRuns]);

  const focus = (next: StateFilter) => {
    setFilter(next);
    setSavedTab("list");
  };

  // swarm 没有 Step：任务页只保留回合运行记录，避免展示空的待领取队列。
  if (graph.project.mode === "swarm") {
    return (
      <section className={embedded ? "tasks-embedded" : "page page-tasks"}>
        {!embedded && (
          <PageHeader
            eyebrow="EXPLORATION / TURNS"
            title="回合记录"
            description="swarm 没有 Step：这里是每个执行者回合的领取、用量与结果。"
            actions={
              <button
                type="button"
                className="button ghost"
                disabled={ws.refreshing || ws.busy}
                onClick={() => void ws.refresh()}
              >
                <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} />
                刷新
              </button>
            }
          />
        )}
        <div className="tasks-runs">
          <RunHistory runs={runs} error={runsError} limit={runLimit} onLimit={setRunLimit} />
        </div>
      </section>
    );
  }

  return (
    <section className={embedded ? "tasks-embedded" : "page page-tasks"}>
      {!embedded && (
        <PageHeader
          eyebrow="EXPLORATION / EXECUTION"
          title="任务与运行"
          description="按状态查看 Step 队列：每次领取、执行与人工关闭都留下可追溯的记录。"
          actions={
            <>
              <span className="tasks-pill">
                <span className="live-dot" data-status={graph.project.status} aria-hidden="true" />
                {ws.events.length.toLocaleString("zh-CN")} 条事件
              </span>
              <button
                type="button"
                className="button ghost"
                disabled={ws.refreshing || ws.busy}
                onClick={() => void ws.refresh()}
              >
                <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} />
                刷新
              </button>
            </>
          }
        />
      )}

      <div className="kpi-grid">
        <Kpi
          label="全部任务"
          value={counts.all}
          note={counts.open ? `${counts.open} 个待领取` : "没有待领取的任务"}
          icon={<ListChecks size={14} />}
          hint="显示全部任务"
          onClick={() => focus("all")}
        />
        <Kpi
          label="执行中"
          value={counts.running}
          tone="accent"
          note="Worker 已领取，等待结果"
          icon={<LoaderCircle size={14} />}
          hint="只看执行中的任务"
          onClick={() => focus("running")}
        />
        <Kpi
          label="待关闭"
          value={counts.executed}
          tone={counts.executed ? "warn" : "neutral"}
          note="执行结束，等待人工决策"
          icon={<Clock3 size={14} />}
          hint="只看待关闭的任务"
          onClick={() => focus("executed")}
        />
        <Kpi
          label="需关注"
          value={counts.attention}
          tone={counts.attention ? "danger" : "neutral"}
          note={orphanRuns.length ? `失败或需人工检查 · 含 ${orphanRuns.length} 次未结案运行` : "失败或需人工检查"}
          icon={<TriangleAlert size={14} />}
          hint="只看失败、需人工检查的任务与未结案运行"
          onClick={() => focus("attention")}
        />
        <Kpi
          label="已完成"
          value={counts.done}
          tone={counts.done ? "success" : "neutral"}
          note="已关闭，问题已答够"
          icon={<CircleCheckBig size={14} />}
          hint="只看已完成的任务"
          onClick={() => focus("done")}
        />
      </div>

      <Tabs value={tab} options={TABS} onChange={setSavedTab} ariaLabel="任务与运行视图" />

      {tab === "list" ? (
        <TaskList filter={filter} onFilter={setFilter} orphanRuns={orphanRuns} onOpenRuns={() => setSavedTab("runs")} />
      ) : (
        <div className="tasks-runs">
          <RunHistory runs={runs} error={runsError} limit={runLimit} onLimit={setRunLimit} />
        </div>
      )}
    </section>
  );
}

function TaskList({
  filter,
  onFilter,
  orphanRuns,
  onOpenRuns,
}: {
  filter: StateFilter;
  onFilter: (value: StateFilter) => void;
  orphanRuns: Run[];
  onOpenRuns: () => void;
}) {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = graph.project.id;
  const [query, setQuery] = useViewState(`${projectId}:tasks:search`, "");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [decision, setDecision] = useState<Step | null>(null);

  const needle = query.trim().toLowerCase();
  useEffect(() => {
    setShown(PAGE_SIZE);
  }, [filter, needle]);

  const evidenceByStep = useMemo(() => {
    const index = new Map<string, StepEvidence>();
    for (const item of graph.evidence) {
      if (!item.step_id) continue;
      const current = index.get(item.step_id);
      if (!current) index.set(item.step_id, { count: 1, latest: item });
      else if (Date.parse(item.created_at) >= Date.parse(current.latest.created_at)) {
        current.count += 1;
        current.latest = item;
      } else current.count += 1;
    }
    return index;
  }, [graph.evidence]);

  const steps = useMemo(
    () =>
      graph.steps
        .filter((step) => {
          if (!matchesFilter(step, filter)) return false;
          if (!needle) return true;
          return [
            step.id,
            step.description,
            step.property,
            step.method_hint,
            step.summary,
            step.graph_id,
            (step.hint_ids ?? []).join(" "),
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle);
        })
        .sort((a, b) => {
          const newest = Date.parse(b.created_at) - Date.parse(a.created_at);
          return newest || b.id.localeCompare(a.id, undefined, { numeric: true });
        }),
    [graph.steps, filter, needle],
  );

  const rows = steps.slice(0, shown);
  const paused = graph.project.status === "stopped";

  const toggleExpanded = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="tasks-list-region">
      <div className="toolbar tasks-toolbar">
        <Segmented
          value={filter}
          onChange={onFilter}
          ariaLabel="按状态筛选任务"
          size="sm"
          options={FILTERS.map(
            ([key, label]) =>
              [key, `${label} ${countOf(key, graph.steps) + (key === "attention" ? orphanRuns.length : 0)}`] as const,
          )}
        />
        <span className="toolbar-hint tasks-shown">
          显示 {rows.length} / {steps.length}
        </span>
        <span className="spacer" />
        <label className="search-input tasks-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索任务"
            placeholder="搜索 ID、描述、结果或黑板"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {rows.length ? (
        <div className="tasks-list">
          {rows.map((step) => (
            <TaskRow
              key={step.id}
              step={step}
              evidence={evidenceByStep.get(step.id)}
              expanded={expanded.has(step.id)}
              paused={paused}
              onToggle={() => toggleExpanded(step.id)}
              onDecide={() => setDecision(step)}
            />
          ))}
        </div>
      ) : graph.steps.length ? (
        <EmptyState
          icon={<Activity size={20} />}
          title="没有匹配的任务"
          desc="换一个状态筛选，或清空搜索关键词。"
          action={
            <button
              type="button"
              className="button"
              onClick={() => {
                onFilter("all");
                setQuery("");
              }}
            >
              清空筛选
            </button>
          }
        />
      ) : (
        <EmptyState
          icon={<ListChecks size={20} />}
          title="还没有任务"
          desc="Decide 会根据目标与已有观测创建 Step；领取后在这里跟踪执行与关闭。"
        />
      )}

      {filter === "attention" && orphanRuns.length > 0 && (
        <div className="tasks-run-alert">
          <p className="tasks-alert">还有 {orphanRuns.length} 次运行停在“需人工检查”，对应任务不在上面的列表里。</p>
          {orphanRuns.map((run) => (
            <div className="tasks-run-alert-row" key={run.id}>
              <span className="mono">{run.id}</span>
              <span>
                {run.node_id || "—"} · 第 {run.attempt} 次
              </span>
              <span className="quiet">{readableError(run.error) || "未记录失败原因"}</span>
              <button type="button" className="button small" onClick={onOpenRuns}>
                查看运行记录
              </button>
            </div>
          ))}
        </div>
      )}

      {steps.length > shown && (
        <div className="tasks-more-row">
          <button type="button" className="button" onClick={() => setShown((value) => value + PAGE_SIZE)}>
            显示更多（还有 {steps.length - shown} 个）
          </button>
        </div>
      )}

      {decision && <StepDecision step={decision} onClose={() => setDecision(null)} onDone={() => setDecision(null)} />}
    </div>
  );
}

function TaskRow({
  step,
  evidence,
  expanded,
  paused,
  onToggle,
  onDecide,
}: {
  step: Step;
  evidence?: StepEvidence;
  expanded: boolean;
  paused: boolean;
  onToggle: () => void;
  onDecide: () => void;
}) {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const state = stepState(step);
  const blockedBy = unmetDependencies(graph, step);
  const hints = step.hint_ids ?? [];
  const effective = hints.reduce((value, hintId) => {
    const hint = graph.hints.find((item) => item.id === hintId && !item.withdrawn_at);
    return Math.max(value, hint?.priority ?? 0);
  }, step.priority);
  const description = prettyText(step.description);
  const long = description.length > 160;
  const failedSummary = /^Execution failed:/.test(step.summary);
  const failure =
    (state === "failed" || state === "needs_attention") && failedSummary
      ? readableError(step.summary.replace(/^Execution failed:\s*/, ""))
      : "";
  const summary = failedSummary ? "" : prettyText(step.summary);

  return (
    <article className="tasks-row" data-state={state}>
      <header className="tasks-row-head">
        <button
          type="button"
          className="tasks-id mono"
          title="在黑板中定位这个任务"
          onClick={() => locateRecord(ws, step.id)}
        >
          {step.id}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
        <Badge value={state} />
        {step.depends_on?.length ? (
          <span
            className="tasks-chain"
            data-blocked={blockedBy.length ? "yes" : undefined}
            title={
              blockedBy.length ? `等待前置执行：${blockedBy.join("、")}` : `前置已就绪：${step.depends_on.join("、")}`
            }
          >
            {blockedBy.length ? `等待前置 ${blockedBy.join("、")}` : `前置 ${step.depends_on.join("、")}`}
          </span>
        ) : null}
        <span className="tasks-priority" title={`任务优先级 ${step.priority}；结合提示后的生效优先级 ${effective}`}>
          P{step.priority}
          {effective !== step.priority && <em>→{effective}</em>}
        </span>
        <span className="tasks-chip">v{step.version ?? 1}</span>
        <span className="tasks-attempts">领取 {step.attempts}</span>
        {hints.length > 0 && (
          <span className="tasks-hints">
            {hints.map((hintId) => {
              const hint = graph.hints.find((item) => item.id === hintId);
              return (
                <span
                  className="tasks-hint"
                  key={hintId}
                  data-withdrawn={hint?.withdrawn_at ? "true" : undefined}
                  title={hint ? `${hint.content}${hint.withdrawn_at ? "（已撤回）" : ""}` : `${hintId}（提示已不存在）`}
                >
                  {hintId}
                </span>
              );
            })}
          </span>
        )}
        <time className="tasks-time" dateTime={step.created_at} title={fmt(step.created_at)}>
          {fromNow(step.created_at)}
        </time>
      </header>

      <p className={long && !expanded ? "tasks-desc clamp" : "tasks-desc"}>{description}</p>
      {long && (
        <button type="button" className="button subtle tasks-desc-toggle" onClick={onToggle}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}

      {(step.property || step.method_hint) && (
        <div className="tasks-property">
          {step.property && (
            <p>
              <span>验收属性</span>
              {prettyText(step.property)}
            </p>
          )}
          {step.method_hint && (
            <p className="quiet">
              <span>方法建议</span>
              {prettyText(step.method_hint)}
            </p>
          )}
        </div>
      )}

      {state === "needs_attention" && <p className="tasks-alert">上次运行中断，需人工检查原始证据后重试或关闭。</p>}
      {step.close_reason && <p className="tasks-close-reason">关闭理由：{step.close_reason}</p>}
      {failure && <p className="tasks-outcome tasks-failure">{failure}</p>}
      {!failure && summary && <p className="tasks-outcome">{summary}</p>}

      <footer className="tasks-row-foot">
        <span>{step.fact_ids.length} 条事实</span>
        <span>{evidence?.count ?? 0} 份证据</span>
        <span className="mono">{fmt(step.created_at)}</span>
        {step.retry_at && !step.worker && !step.concluded_at && (
          <span className="tasks-retry" data-paused={paused ? "true" : undefined}>
            {paused ? "项目已暂停，重试已停止" : `下次可领取 ${fmt(step.retry_at)}`}
          </span>
        )}
        <div className="tasks-row-actions">
          <button type="button" className="button small" onClick={() => locateRecord(ws, step.id)}>
            查看任务
          </button>
          <button
            type="button"
            className="button small"
            disabled={!evidence}
            title={evidence ? `打开最新证据 ${evidence.latest.id}` : "这个任务还没有证据"}
            onClick={() => {
              if (!evidence) return;
              ws.navigate("evidence");
              void ws.showEvidence(evidence.latest);
            }}
          >
            <FileText size={12} aria-hidden="true" />
            证据
          </button>
          <button
            type="button"
            className={step.concluded_at ? "button small ghost" : "button small"}
            disabled={ws.busy}
            onClick={onDecide}
          >
            {step.concluded_at ? "重开" : "关闭"}
          </button>
        </div>
      </footer>
    </article>
  );
}
