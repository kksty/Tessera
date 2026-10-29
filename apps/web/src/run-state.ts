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
  return { actionable: true, label: "需人工检查", note: "先核对原始证据与外部动作，再决定重试或关闭。" };
}

export type RunOutcomeTone = "danger" | "warn" | "neutral";

export interface RunOutcome {
  label: string;
  tone: RunOutcomeTone;
  note: string;
}

/**
 * 运行记录的展示口径：只有 needs_attention 真需要人。`failed` 只是那一次尝试的历史——
 * 后面的 attempt 已经接手、或项目被连续失败暂停，都不该继续显示成“等你处理”。
 * failed 且项目仍在跑时，调度器会在退避后重新领取，所以是“等待自动重试”。
 */
export function runOutcome(
  run: Run,
  step: Step | undefined,
  options: { latest?: Run; projectStatus?: string } = {},
): RunOutcome | null {
  const attention = runAttention(run, step);
  if (attention)
    return { label: attention.label, tone: attention.actionable ? "danger" : "neutral", note: attention.note };
  if (run.status !== "failed") return null;
  // 失败的 Execute 也可能随任务关闭/废弃一起结案：这时不会再有自动重试。
  if (run.kind === "execute" && step) {
    if (step.deleted) return { label: "已处理", tone: "neutral", note: `任务 ${step.id} 已删除，此运行仅留档。` };
    if (step.concluded_at || step.discarded)
      return {
        label: "已处理",
        tone: "neutral",
        note: `任务 ${step.id} 已${step.discarded ? "废弃" : "关闭"}，此运行仅留档。`,
      };
  }
  if (options.latest && options.latest.attempt > run.attempt)
    return {
      label: `已被第 ${options.latest.attempt} 次接管`,
      tone: "neutral",
      note: `第 ${options.latest.attempt} 次已接手同一${
        run.kind === "decide" ? "决策" : run.kind === "review" ? "审核" : run.kind === "peer" ? "执行者回合" : "任务"
      }；这条失败记录、证据与用量仅留档。`,
    };
  if (options.projectStatus === "stopped")
    return {
      label: "项目已暂停",
      tone: "warn",
      note: "连续失败已触发暂停；恢复项目后调度器才会继续重试。",
    };
  if (options.projectStatus === "active")
    return { label: "等待自动重试", tone: "warn", note: "失败已记录，调度器会按退避重新领取。" };
  return null;
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
