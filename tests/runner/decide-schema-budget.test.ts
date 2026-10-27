import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { submitDecisionsBase } from "../../packages/protocol/src/index.js";
import { stepLine } from "../../packages/core/src/projection.js";
import { promptFor, testDomainGuidance } from "../../packages/runner/src/prompts.js";

/** 与 run.ts 暴露给 Decide 的工具参数保持一致（运行时代填字段省略）。 */
function decideToolSchema(): any {
  const params = z.object(submitDecisionsBase.shape).strict().omit({
    worker: true,
    revision: true,
    observation_revision: true,
    planning_revision: true,
    graph_id: true,
    submission_id: true,
    plan_id: true,
    deletion_preview_hash: true,
  });
  return z.toJSONSchema(params, { io: "input" });
}

test("测试域只占 Decide 的 Schema 与一句正文，不把域表贴进提示词", () => {
  const schema = decideToolSchema();
  const fields = [
    schema.properties.steps.items.properties.test_domain,
    schema.properties.steps.items.properties.focus,
    schema.properties.updates.items.properties.test_domain,
    schema.properties.updates.items.properties.focus,
  ];
  const contribution = fields.reduce((total, field) => total + (field ? JSON.stringify(field).length : 0), 0);
  assert.ok(contribution <= 500, `测试域字段占 ${contribution} 字符，超过 500 字符预算`);
  assert.ok(
    testDomainGuidance.length <= 200,
    `Decide 正文的测试域说明 ${testDomainGuidance.length} 字，超过 200 字预算`,
  );

  const decide = promptFor({ kind: "decide" } as any, {}, {} as any);
  assert.ok(decide.includes(testDomainGuidance), "Decide 正文必须带上分类边界");
  // 分类只在决策时填写：执行与审核不新增字段，也不重复这段说明。
  for (const kind of ["execute", "review"])
    assert.equal(
      promptFor({ kind } as any, {}, {} as any).includes(testDomainGuidance),
      false,
      `${kind} 提示词不应重复测试域说明`,
    );

  // Step 索引里的分类短码必须压在一行内，不能把 focus 也搬进去。
  const base = {
    id: "s001",
    from: ["f001"],
    to: null,
    description: "Probe the login form",
    priority: 0,
    discarded: false,
    creator: "planner",
    worker: null,
    last_heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    concluded_at: null,
    fact_ids: [],
    summary: "",
    graph_id: "main",
    attempts: 0,
  } as any;
  const annotated = stepLine({ ...base, test_domain: "recon", focus: "资产：子域枚举" });
  assert.ok(annotated.length - stepLine(base).length <= 10, "Step 行的域短码必须 ≤10 字符");
  assert.ok(annotated.includes("[recon]"));
  assert.equal(annotated.includes("资产：子域枚举"), false, "focus 不进入 Step 索引投影");
});
