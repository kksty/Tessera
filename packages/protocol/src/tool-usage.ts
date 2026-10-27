/** Agent 工具调用统计：服务端按诊断事件聚合，前端按阶段筛选并排序。 */
export type ToolPhase = "decide" | "execute" | "review";
export const toolPhases = ["decide", "execute", "review"] as const;
export const toolPhaseLabels: Record<ToolPhase | "all", string> = {
  all: "全部",
  decide: "决策",
  execute: "执行",
  review: "审核",
};

/** 同一工具在一个 Run 类型里的计数；缺失的字段保持未知，不用 0 冒充。 */
export interface ToolKindUsage {
  calls: number;
  ended: number;
  errors: number;
  /** 已结束且上报了耗时的调用数；平均耗时只除以它。 */
  timed: number;
  elapsed_ms: number;
  last_at: string | null;
}

export interface ToolUsage extends ToolKindUsage {
  tool: string;
  by_kind: Partial<Record<ToolPhase | "unknown", ToolKindUsage>>;
}

export interface ToolUsageTotals {
  tools: number;
  calls: number;
  ended: number;
  errors: number;
  timed: number;
  elapsed_ms: number;
}

/** GET /api/projects/:id/tool-usage 的响应。 */
export interface ToolUsageReport {
  through: number;
  tools: ToolUsage[];
  totals: ToolUsageTotals;
  note: string;
}

export interface ToolRankRow extends ToolKindUsage {
  tool: string;
  average_ms: number | null;
  /** 当前筛选内的相对长度，最大值为 1。 */
  bar: number;
}

/** 按调用次数降序；同次数按工具名稳定排序，选中阶段只保留该阶段有调用的工具。 */
export function rankToolUsage(tools: ToolUsage[], phase: ToolPhase | "all"): ToolRankRow[] {
  const rows = tools
    .flatMap((tool) => {
      const bucket: ToolKindUsage | undefined = phase === "all" ? tool : tool.by_kind[phase];
      if (!bucket || bucket.calls <= 0) return [];
      return [
        {
          tool: tool.tool,
          calls: bucket.calls,
          ended: bucket.ended,
          errors: bucket.errors,
          timed: bucket.timed,
          elapsed_ms: bucket.elapsed_ms,
          last_at: bucket.last_at ?? null,
          average_ms: bucket.timed ? bucket.elapsed_ms / bucket.timed : null,
          bar: 0,
        },
      ];
    })
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
  const max = rows.reduce((peak, row) => Math.max(peak, row.calls), 0);
  return rows.map((row) => ({ ...row, bar: max ? row.calls / max : 0 }));
}

/** 工具调用耗时的可读形式；没有上报耗时就是未知，不当作 0。 */
export function toolDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (ms < 3_600_000) return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
  return `${Math.floor(ms / 3_600_000)} 小时 ${minutes % 60} 分`;
}
