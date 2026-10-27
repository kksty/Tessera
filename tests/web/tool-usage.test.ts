import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankToolUsage,
  toolDuration,
  type ToolKindUsage,
  type ToolUsage,
} from "../../packages/protocol/src/tool-usage.js";

const bucket = (overrides: Partial<ToolKindUsage> = {}): ToolKindUsage => ({
  calls: 0,
  ended: 0,
  errors: 0,
  timed: 0,
  elapsed_ms: 0,
  last_at: null,
  ...overrides,
});

const usage = (
  tool: string,
  overrides: Partial<ToolKindUsage> = {},
  by_kind: ToolUsage["by_kind"] = {},
): ToolUsage => ({
  tool,
  ...bucket(),
  ...overrides,
  by_kind,
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test("工具排行按调用次数降序，同次数按名字稳定排序", () => {
  const tools = [
    usage("read", bucket({ calls: 4, ended: 3, timed: 3, elapsed_ms: 300 }), {
      execute: bucket({ calls: 4, ended: 3, timed: 3, elapsed_ms: 300 }),
    }),
    usage("bash", bucket({ calls: 10, ended: 8, errors: 2, timed: 8, elapsed_ms: 8000 }), {
      execute: bucket({ calls: 6, ended: 5, timed: 5, elapsed_ms: 6000 }),
      review: bucket({ calls: 4, ended: 3, timed: 3, elapsed_ms: 2000 }),
    }),
    usage("read_graph", bucket({ calls: 4, ended: 4, timed: 4, elapsed_ms: 80 }), {
      decide: bucket({ calls: 4, ended: 4, timed: 4, elapsed_ms: 80 }),
    }),
    usage("unused"),
  ];
  const all = rankToolUsage(tools, "all");
  assert.deepEqual(
    all.map((row) => [row.tool, row.calls]),
    [
      ["bash", 10],
      ["read", 4],
      ["read_graph", 4],
    ],
  );
  assert.equal(all[0].bar, 1);
  assert.equal(all[1].bar, 0.4);
  assert.equal(all[0].average_ms, 1000);
  assert.equal(all[0].errors, 2);

  const execute = rankToolUsage(tools, "execute");
  assert.deepEqual(
    execute.map((row) => [row.tool, row.calls]),
    [
      ["bash", 6],
      ["read", 4],
    ],
  );
  assert.equal(execute[0].bar, 1);
  assert.equal(execute[1].bar, 4 / 6);
  const review = rankToolUsage(tools, "review");
  assert.deepEqual(
    review.map((row) => row.tool),
    ["bash"],
  );
  assert.equal(review[0].calls, 4);
  const decide = rankToolUsage(tools, "decide");
  assert.deepEqual(
    decide.map((row) => row.tool),
    ["read_graph"],
  );
});

test("阶段筛选使用该阶段的最近调用与耗时，未上报耗时保持未知", () => {
  const tools = [
    usage("bash", bucket({ calls: 3, ended: 2, timed: 1, elapsed_ms: 500, last_at: at(30) }), {
      execute: bucket({ calls: 3, ended: 2, timed: 1, elapsed_ms: 500, last_at: at(30) }),
      review: bucket({ calls: 0, last_at: at(1) }),
    }),
  ];
  const execute = rankToolUsage(tools, "execute")[0];
  assert.equal(execute.average_ms, 500);
  assert.equal(execute.last_at, tools[0].by_kind.execute?.last_at);
  // 当前阶段没有调用就不出现在排行里，即使别的阶段有最近调用。
  assert.deepEqual(rankToolUsage(tools, "review"), []);
  assert.equal(rankToolUsage([usage("bash")], "all").length, 0);
});

test("工具耗时只格式化已上报的数字", () => {
  assert.equal(toolDuration(null), "—");
  assert.equal(toolDuration(undefined), "—");
  assert.equal(toolDuration(Number.NaN), "—");
  assert.equal(toolDuration(0), "0 ms");
  assert.equal(toolDuration(999), "999 ms");
  assert.equal(toolDuration(1000), "1.0 s");
  assert.equal(toolDuration(12_340), "12.3 s");
  assert.equal(toolDuration(60_000), "1 分 0 秒");
  assert.equal(toolDuration(125_000), "2 分 5 秒");
  assert.equal(toolDuration(3_600_000), "1 小时 0 分");
  assert.equal(toolDuration(7_500_000), "2 小时 5 分");
});
