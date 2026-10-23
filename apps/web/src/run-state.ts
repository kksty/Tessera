import type { Run, Step } from "../../../packages/protocol/src/index.js";

/** 运行记录条数：接口允许 1–1000，页面只暴露几个常用档位。 */
export const RUN_LIMITS = [100, 200, 500, 1000] as const;
export const DEFAULT_RUN_LIMIT = 200;

const resolvedLabels: Record<string, string> = {
  operator: "已由人工确认重试",
  "step.closed": "任务关闭时一并结案",
  "step.discarded": "任务废弃时一并结案",
  "step.reopened": "任务已重开，后续运行接管",
};

export interface RunAttention {
  /** true 才需要人工去确认重试，其余只是历史记录。 */
  actionable: boolean;
  label: string;
  note: string;
}

/**
 * needs_attention 只说明“这次运行没正常结束”。要不要人处理取决于它背后的 Step：
 * Step 一旦关闭、废弃、删除或重开，这张单子就已经有人拍板，运行记录不该再喊人。
 * 与 packages/core 的 endRun / settleBlockedRun 保持同一套判定。
 */
export function runAttention(run: Run, step?: Step): RunAttention | null {
  if (run.status !== "needs_attention") return null;
  if (run.resolved_at) {
    const settled = resolvedLabels[run.resolved_by || ""];
    return { actionable: false, label: "已处理", note: `${settled || "已结案"}；失败记录、原始证据与用量保留。` };
  }
  if (!step) return { actionable: false, label: "已处理", note: "关联任务已不存在，此运行仅留档。" };
  if (step.deleted) return { actionable: false, label: "已处理", note: `任务 ${step.id} 已删除，此运行仅留档。` };
  if (step.concluded_at || step.discarded)
    return {
      actionable: false,
      label: "已处理",
      note: `任务 ${step.id} 已${step.discarded ? "废弃" : "关闭"}，此运行无需重试。`,
    };
  if (step.blocked_run_id !== run.id)
    return { actionable: false, label: "已处理", note: "该任务已由后续运行接管，此运行仅留档。" };
  if (step.worker) return { actionable: false, label: "已处理", note: "任务已有新的执行者占用，此运行仅留档。" };
  return { actionable: true, label: "需人工检查", note: "检查工作区与原始证据后确认重试。" };
}

/** 还需要人拍板的运行：没有结案标记，且 Step 仍在进行中的问题里。 */
export function unsettledRun(run: Run, step?: Step) {
  return (
    run.status === "needs_attention" &&
    !run.resolved_at &&
    !!step &&
    !step.deleted &&
    !step.concluded_at &&
    !step.discarded
  );
}
