import { Route, Users } from "lucide-react";
import type { ProjectMode } from "../../../../packages/protocol/src/index.js";

/**
 * 两种任务架构在前端共用同一套视觉语言：徽章只表达「谁在规划」，
 * 不暗示新旧或强弱。持久化值仍是 classic；历史项目没有 mode 字段时按决策者架构显示。
 */
export const modeLabels: Record<
  ProjectMode,
  { label: string; short: string; summary: string; fit: string; detail: string }
> = {
  classic: {
    label: "决策者架构",
    short: "决策者",
    summary: "Decide / Execute / Review · 单一决策入口",
    fit: "资产测绘、合规扫描、边界明确的独立子任务",
    detail:
      "决策者统一读图、定方向并开 Step，执行者逐 Step 执行，Review 独立审核。适合需要全局排队、统一优先级与确定性流水线的任务。",
  },
  swarm: {
    label: "蜂群架构",
    short: "蜂群",
    summary: "平等执行者 · 持久会话 · 消息与共识",
    fit: "未知状态、线索互相依赖、需要连续上下文的探索",
    detail:
      "每个执行者自己决定方向，在持久会话里连续规划与执行，通过消息协作、以全体共识完成。没有决策者，也没有 Step。",
  },
};

export const normalizedMode = (mode?: ProjectMode): ProjectMode => (mode === "swarm" ? "swarm" : "classic");

export function ModeBadge({ mode, compact = false }: { mode?: ProjectMode; compact?: boolean }) {
  const key = normalizedMode(mode);
  const info = modeLabels[key];
  const Icon = key === "swarm" ? Users : Route;
  return (
    <span
      className="mode-badge"
      data-mode={key}
      data-compact={compact || undefined}
      title={`${info.label}：${info.detail}`}
    >
      <Icon size={compact ? 11 : 12} strokeWidth={2} aria-hidden="true" />
      <span>{compact ? info.short : info.label}</span>
    </span>
  );
}
