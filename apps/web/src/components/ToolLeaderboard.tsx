import { useMemo, useState } from "react";
import { RefreshCw, Wrench } from "lucide-react";
import type { Graph } from "../../../../packages/protocol/src/index.js";
import {
  rankToolUsage,
  toolDuration,
  toolPhaseLabels,
  toolPhases,
  type ToolPhase,
} from "../../../../packages/protocol/src/tool-usage.js";
import { compactNumber, fmt, fromNow } from "../format.js";
import { useToolUsage } from "../tool-usage.js";
import { Card, EmptyState, Segmented, Skeleton } from "./ui.js";

const PHASES: readonly (readonly [ToolPhase | "all", string])[] = [
  ["all", toolPhaseLabels.all],
  ...toolPhases.map((phase) => [phase, toolPhaseLabels[phase]] as const),
];

/** 项目概览里的 Agent 工具调用排行；只展示诊断事件能证明的调用。 */
export function ToolLeaderboard({ graph }: { graph: Graph }) {
  const { report, error, loading, reload } = useToolUsage(graph.project.id, graph.revision);
  const [phase, setPhase] = useState<ToolPhase | "all">("all");
  const rows = useMemo(() => (report ? rankToolUsage(report.tools, phase) : []), [report, phase]);
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  const errors = rows.reduce((sum, row) => sum + row.errors, 0);
  const timed = rows.reduce((sum, row) => sum + row.timed, 0);
  const elapsed = rows.reduce((sum, row) => sum + row.elapsed_ms, 0);
  const average = timed ? elapsed / timed : null;

  return (
    <Card
      id="overview-tools"
      className="tool-leaderboard"
      icon={<Wrench size={15} />}
      title="工具调用排行"
      note="按 tool_start / tool_end 诊断事件统计"
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="刷新工具统计"
          title="刷新工具统计"
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={14} className={loading ? "spin" : undefined} />
        </button>
      }
    >
      {report && report.tools.length > 0 && (
        <div className="tool-leaderboard-bar">
          <div className="tool-leaderboard-totals">
            <span>
              <b>{compactNumber(total)}</b> 次调用
            </span>
            <span>
              <b>{rows.length}</b> 种工具
            </span>
            <span data-tone={errors ? "danger" : undefined}>
              <b>{compactNumber(errors)}</b> 次失败
            </span>
            {average !== null && (
              <span>
                平均 <b>{toolDuration(average)}</b>
              </span>
            )}
          </div>
          <Segmented value={phase} onChange={setPhase} options={PHASES} ariaLabel="按 Run 类型筛选工具调用" size="sm" />
        </div>
      )}

      {error ? (
        <div className="tool-leaderboard-fallback" role="alert">
          <span>{error}</span>
          <button type="button" className="button small" onClick={reload}>
            重试
          </button>
        </div>
      ) : !report ? (
        <Skeleton rows={5} />
      ) : !report.tools.length ? (
        <EmptyState
          compact
          icon={<Wrench size={18} />}
          title="还没有工具调用"
          desc="Agent 执行任务时会调用 read、bash 等工具；诊断事件到达后，这里按次数排序。"
        />
      ) : !rows.length ? (
        <p className="tool-leaderboard-quiet">{toolPhaseLabels[phase]}阶段还没有工具调用。</p>
      ) : (
        <ol className="tool-rank" aria-label="工具调用次数排行">
          {rows.map((row, index) => {
            const rate = row.ended ? Math.round((row.errors / row.ended) * 100) : 0;
            return (
              <li className="tool-rank-row" key={row.tool} data-rank={index + 1}>
                <span className="tool-rank-no mono">{String(index + 1).padStart(2, "0")}</span>
                <div className="tool-rank-main">
                  <div className="tool-rank-head">
                    <code className="tool-rank-name" title={row.tool}>
                      {row.tool}
                    </code>
                    <span className="tool-rank-count">{compactNumber(row.calls)} 次</span>
                  </div>
                  <span className="tool-rank-track" aria-hidden="true">
                    <i style={{ width: `${Math.max(row.bar * 100, 1.5)}%` }} />
                  </span>
                  <div className="tool-rank-meta">
                    {row.errors > 0 && (
                      <span
                        className="tool-rank-error"
                        title={`${row.errors} 次调用以错误结束，占已结束调用的 ${rate}%`}
                      >
                        {compactNumber(row.errors)} 次失败
                      </span>
                    )}
                    {row.average_ms !== null && (
                      <span title={`平均耗时只统计已上报耗时的 ${row.timed} 次调用`}>
                        平均 {toolDuration(row.average_ms)}
                      </span>
                    )}
                    {row.last_at && <span title={fmt(row.last_at)}>最近 {fromNow(row.last_at)}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {report && report.tools.length > 0 && (
        <p className="tool-leaderboard-note">
          调用次数来自 tool_start；失败与耗时来自同一工具的 tool_end，按名称归组，未结束的调用只计次数。旧 Run
          缺少诊断事件时不会补算。
        </p>
      )}
    </Card>
  );
}
