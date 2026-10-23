import { useMemo, useState } from "react";
import { ExternalLink, RotateCcw } from "lucide-react";
import type { Run } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { fmt } from "../format.js";
import { RUN_LIMITS, runAttention } from "../run-state.js";
import { locateRecord, useWorkspace } from "../workspace.js";
import { Badge, Card, EmptyState, Modal } from "./ui.js";

const kinds = { decide: "决策", execute: "探索", review: "审核" } as const;

/** 运行记录由任务页统一轮询：列表、条数与「需关注」计数共用同一个数据源。 */
export function RunHistory({
  runs,
  error,
  limit,
  onLimit,
  onReload,
}: {
  runs: Run[];
  error: string;
  limit: number;
  onLimit: (value: number) => void;
  onReload: () => void;
}) {
  const ws = useWorkspace();
  const id = ws.id!;
  const [retryTarget, setRetryTarget] = useState<Run | null>(null);
  const steps = useMemo(
    () => new Map((ws.graph?.steps ?? []).map((step) => [step.id, step])),
    [ws.graph],
  );

  async function retry(run: Run) {
    await ws.action(async () => {
      await api(path(id, `/runs/${run.id}/retry`), { confirmed: true });
      await ws.refresh();
      onReload();
    });
    setRetryTarget(null);
  }

  return (
    <Card
      title="运行记录"
      note={`最近 ${runs.length} 次`}
      actions={
        <label className="run-limit">
          <span>显示</span>
          <select
            aria-label="运行记录条数"
            value={limit}
            onChange={(event) => onLimit(Number(event.target.value))}
          >
            {RUN_LIMITS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <span>条</span>
        </label>
      }
      flush
    >
      {error && <p className="banner danger">{error}</p>}
      {!runs.length && !error && (
        <EmptyState compact title="尚无运行记录" desc="每次领取任务的独立记录会出现在这里。" />
      )}
      {runs.map((run) => {
        const seconds = Math.max(
          0,
          (Date.parse(run.finished_at || new Date().toISOString()) - Date.parse(run.started_at)) / 1000,
        );
        const step = run.node_id ? steps.get(run.node_id) : undefined;
        const attention = runAttention(run, step);
        return (
          <details className="run-row" key={run.id}>
            <summary>
              <span className="run-kind">{kinds[run.kind]}</span>
              <span className="mono">{run.node_id || "—"}</span>
              <span className="quiet">第 {run.attempt} 次</span>
              {attention ? (
                <span className="status-pill" data-tone={attention.actionable ? "danger" : "neutral"}>
                  <i aria-hidden="true" />
                  {attention.label}
                </span>
              ) : (
                <Badge value={run.status} />
              )}
              <span className="spacer" />
              <span className="quiet tabular">{Math.round(seconds)} 秒</span>
            </summary>
            <div className="run-body">
              <p className="mono quiet">
                {run.id} · {run.worker}
              </p>
              <p>
                {fmt(run.started_at)} → {run.finished_at ? fmt(run.finished_at) : "尚未结束"}
              </p>
              <p>
                请求 {run.request_count} 次 · 输入 {run.input ?? "未知"} / 输出 {run.output ?? "未知"} tokens ·
                费用 {run.cost ?? "未知"}
                {run.unknown_request_count
                  ? ` · ${run.unknown_request_count} 次请求用量未取得`
                  : ""}
              </p>
              <p className="quiet">
                普通输入（SDK） {run.input_uncached ?? "未知"} · 缓存读 {run.cache_read ?? "未知"} / 写{" "}
                {run.cache_write ?? "未知"} tokens
              </p>
              {run.error && <p className="run-error">{run.error}</p>}
              {run.capacity && (
                <p className="quiet">
                  上下文估算 {run.capacity.current ?? "未知"} · 峰值 {run.capacity.peak ?? "未知"} tokens ·
                  压缩代次 {run.capacity.generation}
                </p>
              )}
              {run.session_path && <p className="mono quiet">会话：{run.session_path}</p>}
              {run.external_action_possible && (
                <p className="run-warn">已放行 shell，外部动作可能已发生。</p>
              )}
              {attention && (
                <p className={attention.actionable ? "run-warn" : "run-note"}>{attention.note}</p>
              )}
              <div className="run-actions">
                {run.node_id && run.kind !== "decide" && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => locateRecord(ws, run.node_id!)}
                  >
                    <ExternalLink size={12} />
                    查看关联记录
                  </button>
                )}
                {attention?.actionable && (
                  <button
                    type="button"
                    className="button small danger"
                    disabled={ws.busy}
                    onClick={() => setRetryTarget(run)}
                  >
                    <RotateCcw size={12} />
                    检查后确认重试
                  </button>
                )}
              </div>
            </div>
          </details>
        );
      })}

      {retryTarget && (
        <Modal
          label="确认重新执行"
          title="确认重新执行"
          onClose={() => setRetryTarget(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setRetryTarget(null)}>
                取消
              </button>
              <button
                type="button"
                className="button danger"
                disabled={ws.busy}
                onClick={() => void retry(retryTarget)}
              >
                确认重试
              </button>
            </>
          }
        >
          <p>
            {retryTarget.external_action_possible
              ? "这个运行可能已对目标执行动作。请先检查工作区和原始证据。"
              : "请先检查失败原因和现有证据，调整容量、输入或收尾配置。"}
          </p>
          <p className="quiet mono">{retryTarget.id}</p>
        </Modal>
      )}
    </Card>
  );
}
