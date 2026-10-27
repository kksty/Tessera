import type { Graph, Run } from "../../protocol/src/index.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { modelIssue } from "../../protocol/src/model-errors.js";
import { firstSentence, stepState } from "./entry-lines.js";
import type { RunCost } from "./diagnostics.js";

/**
 * 导出用：单个 Step 的执行成本。数字来自 Run 快照和诊断事件，
 * 不写入图，也不参与任何调度、审核或完成判定。
 */
export interface StepCost {
  step_id: string;
  state: string;
  test_domain: string | null;
  /** 完整问题里的可证伪属性，截断后保留在导出里，便于认出是哪类 Step 变长。 */
  property: string | null;
  description: string;
  runs: number;
  /** Step 被领取的次数；取消或补交也可能增加它。与 runs 分开看。 */
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  /** 用量不完整的 Run 数：完全缺失或部分请求缺失；合计 token 只是已知部分，不能当作完整。 */
  unknown_usage_runs: number;
  /** 所有 Run 里最高的上下文投影估值（token）。 */
  peak_context: number | null;
  compactions: number;
  tool_calls: number;
  compaction_anchors: number;
  compaction_anchor_failures: number;
  closeouts: number;
  /** 以上下文容量失败结束的 Run 数；也包含首次入口超窗。 */
  context_failures: number;
  needs_attention_runs: number;
  /** 已结束 Run 的墙钟耗时合计；运行中的 Run 不计入。 */
  wall_time_ms: number;
}

export interface StepCosts {
  /** 活动图里的 Step 数；没有 execute Run 的 Step 也保留一行。 */
  steps: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  compactions: number;
  tool_calls: number;
  context_failures: number;
  needs_attention_runs: number;
  /** 至少触发过一次会话压缩的 Step 数：判断「长 Step」最直接的计数。 */
  compacted_steps: number;
  /** 单 Step 的最大压缩次数。 */
  max_compactions: number;
  rows: StepCost[];
}

const ZERO_COST: RunCost = { tool_calls: 0, compactions: 0, anchors: 0, anchor_failures: 0, closeouts: 0 };

/**
 * 把 execute Run 的成本按 Step 聚合。压缩次数优先取诊断事件计数；
 * 旧 Run 没有事件时回退 Pi 会话代数，两种来源不叠加，避免重复计数。
 * 按压缩次数、输入 token 降序排列，导出文件里最长的 Step 排在最前。
 */
export function stepCosts(graph: Graph, runs: Run[], costs: Map<string, RunCost>): StepCosts {
  const byStep = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.kind !== "execute" || !run.node_id) continue;
    const owned = byStep.get(run.node_id);
    if (owned) owned.push(run);
    else byStep.set(run.node_id, [run]);
  }
  const rows = activeGraph(graph).steps.map((step): StepCost => {
    const owned = byStep.get(step.id) ?? [];
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0,
      unknownUsage = 0,
      peak: number | null = null,
      compactions = 0,
      toolCalls = 0,
      anchors = 0,
      anchorFailures = 0,
      closeouts = 0,
      contextFailures = 0,
      needsAttention = 0,
      wallTime = 0;
    for (const run of owned) {
      // A partially reported Run (some requests without usage) is not complete
      // either; the known tokens still add up, but the Run is flagged as unknown.
      if (run.input === null || (run.unknown_request_count ?? 0) > 0) unknownUsage++;
      if (run.input !== null) input += run.input;
      if (run.output !== null) output += run.output;
      if (run.cache_read != null) cacheRead += run.cache_read;
      if (run.cache_write != null) cacheWrite += run.cache_write;
      if (run.capacity?.peak != null) peak = Math.max(peak ?? 0, run.capacity.peak);
      const observed = costs.get(run.id) ?? ZERO_COST;
      compactions += costs.has(run.id) ? observed.compactions : (run.capacity?.generation ?? 0);
      toolCalls += observed.tool_calls;
      anchors += observed.anchors;
      anchorFailures += observed.anchor_failures;
      closeouts += observed.closeouts;
      if (modelIssue(run.error)?.kind === "context") contextFailures++;
      if (run.status === "needs_attention") needsAttention++;
      if (run.finished_at) {
        const elapsed = Date.parse(run.finished_at) - Date.parse(run.started_at);
        if (Number.isFinite(elapsed) && elapsed > 0) wallTime += elapsed;
      }
    }
    return {
      step_id: step.id,
      state: stepState(step),
      test_domain: step.test_domain ?? null,
      property: step.property ? firstSentence(step.property, 200) : null,
      description: firstSentence(step.description, 200),
      runs: owned.length,
      attempts: step.attempts,
      input_tokens: input,
      output_tokens: output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      unknown_usage_runs: unknownUsage,
      peak_context: peak,
      compactions,
      tool_calls: toolCalls,
      compaction_anchors: anchors,
      compaction_anchor_failures: anchorFailures,
      closeouts,
      context_failures: contextFailures,
      needs_attention_runs: needsAttention,
      wall_time_ms: wallTime,
    };
  });
  rows.sort(
    (a, b) => b.compactions - a.compactions || b.input_tokens - a.input_tokens || a.step_id.localeCompare(b.step_id),
  );
  const sum = (pick: (row: StepCost) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    steps: rows.length,
    runs: sum((row) => row.runs),
    input_tokens: sum((row) => row.input_tokens),
    output_tokens: sum((row) => row.output_tokens),
    compactions: sum((row) => row.compactions),
    tool_calls: sum((row) => row.tool_calls),
    context_failures: sum((row) => row.context_failures),
    needs_attention_runs: sum((row) => row.needs_attention_runs),
    compacted_steps: rows.filter((row) => row.compactions > 0).length,
    max_compactions: rows.reduce((max, row) => Math.max(max, row.compactions), 0),
    rows,
  };
}
