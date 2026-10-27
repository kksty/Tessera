import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFor } from "../../packages/runner/src/prompts.js";

/**
 * 任务提示词只说明角色、字段契约和协议后果；是否删除、合并、撤回或补交由模型判断。
 * 工具本身由工具定义提供，提示词不重复“什么时候用”的取舍建议。
 */
test("任务提示词不规定何时删除或使用工具，只保留数据契约", () => {
  const decide = promptFor({ kind: "decide" } as any, {}, {} as any);
  for (const advice of [
    "自主决定工作图的保留与删除",
    "无需 Hint、人工确认或 Review 批准",
    "提交前用同批 delete_nodes 调用 preview_deletions",
    "结束探索前整理同一入口的发现",
    "无独立价值、重复或超出范围的结论可 withdraw",
  ])
    assert.equal(decide.includes(advice), false, `Decide 提示词不应包含工具取舍指导：${advice}`);

  const execute = promptFor({ kind: "execute" } as any, {}, {} as any);
  for (const advice of [
    "提交 HTTP 结论前用 query_traffic",
    "提交前检索重复",
    "需要作为结论依据的原始产物用 save_evidence",
  ])
    assert.equal(execute.includes(advice), false, `Execute 提示词不应规定何时使用工具：${advice}`);

  // 保留的是可验证的字段与协议契约，而不是取舍建议。
  assert.match(decide, /coverage_surfaces/);
  assert.match(decide, /hint_ids/);
  assert.match(execute, /traffic_ids/);
});
