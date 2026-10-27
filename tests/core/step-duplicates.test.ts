import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, executeSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-step-merge-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Step merge", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  let round = 0;
  const submit = (body: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        submission_id: randomUUID(),
        graph_id: "main",
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...body,
      }),
    );
  };
  const planner = () => {
    store.hint(id, `决策轮次 ${++round}`);
    const job = store.claim(id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    return job;
  };
  const planOne = (input: Record<string, unknown>) => {
    const job = planner();
    return { ...submit({ worker: job.worker, steps: [input] }), worker: job.worker };
  };
  const execute = (stepId: string) => {
    const job = store.claim(id, "executor", 0)!;
    assert.equal(job.step_id, stepId);
    store.execute(
      id,
      stepId,
      executeSchema.parse({ worker: job.worker, facts: ["Observed one endpoint"], summary: "done" }),
    );
  };
  return {
    store,
    id,
    submit,
    planner,
    planOne,
    execute,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const accessStep = {
  from: ["origin"],
  description:
    "对站点已识别的业务接口做未授权访问与越权检查：以无会话或普通身份请求管理类、他人数据接口，观察是否返回受保护数据。全程只读，不修改、不删除任何数据。",
  property: "对若干受保护接口做未授权/低权限访问，确认是否存在未授权读取越权数据（如无响应或 403/401 则记录为阴性）。",
  test_domain: "access",
  focus: "未授权访问",
  priority: 90,
};

const accessRefinement = {
  from: ["origin"],
  description:
    "对站点已识别的业务接口做未授权访问与越权检查：以无会话或匿名身份请求管理类、他人数据接口（如 /cms/recentPurchaseDetail/getRecentPurchaseDetailData.html 的 goodsId 参数、/showListYPXQ.html、/cms/detail.html），观察是否返回受保护数据或错误信息泄露。全程只读，不修改、不删除任何数据。",
  property:
    "对若干受保护/业务接口做未授权访问，确认是否存在未授权读取越权数据；若无响应或 403/401/空结果则记录为阴性，并保留 request 与参数来源。",
  test_domain: "access",
  focus: "越权读取",
  priority: 90,
};

test("a reworded refinement merges into the open Step instead of creating a duplicate", () => {
  const f = fixture();
  try {
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    assert.equal(first.settle.ok, true);
    const refinement = f.planOne(accessRefinement);
    assert.equal(refinement.settle.ok, true);
    assert.deepEqual(refinement.plan.steps, [stepId], "the refinement reuses the queued Step id");
    const graph = f.store.get(f.id);
    assert.equal(graph.steps.length, 1, "no second Step for the same investigation");
    const step = graph.steps[0];
    assert.match(step.description, /匿名身份/);
    assert.match(step.property ?? "", /保留 request/);
    assert.equal(step.version, 2, "the content rewrite advances the version");
    assert.deepEqual(
      step.edits?.map((edit) => edit.field),
      ["description", "property"],
    );
    assert.equal(step.edits?.[0].editor, refinement.worker);
  } finally {
    f.close();
  }
});

test("an exact repeat can still refine property and method without a second Step", () => {
  const f = fixture();
  try {
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    const refined = f.planOne({
      ...accessStep,
      property: `${accessStep.property}同时保留 request 与参数来源。`,
      method_hint: "逐条对照匿名与登录态响应。",
    });
    assert.equal(refined.settle.ok, true);
    assert.deepEqual(refined.plan.steps, [stepId]);
    const graph = f.store.get(f.id);
    assert.equal(graph.steps.length, 1);
    const step = graph.steps[0];
    assert.equal(step.version, 2);
    assert.match(step.property ?? "", /参数来源/);
    assert.match(step.method_hint ?? "", /逐条对照/);
  } finally {
    f.close();
  }
});

test("a refinement re-grounded in a Fact merges and keeps both sources", () => {
  const f = fixture();
  try {
    const recon = f.planOne({
      from: ["origin"],
      description: "对站点做基础信息收集与指纹识别，记录入口与目录结构。",
      property: "完成后能列出指纹与入口。",
      test_domain: "recon",
      focus: "指纹与目录",
      priority: 100,
    });
    f.execute(recon.plan.steps[0]);
    const factId = f.store.get(f.id).facts.find((fact) => fact.id !== "origin")!.id;
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    const refined = f.planOne({ ...accessRefinement, from: [factId] });
    assert.deepEqual(refined.plan.steps, [stepId]);
    const step = f.store.get(f.id).steps.find((value) => value.id === stepId)!;
    assert.deepEqual([...step.from].sort(), ["origin", factId].sort());
    assert.match(step.description, /匿名身份/);
    assert.equal(step.version, 2);
  } finally {
    f.close();
  }
});

test("a materially different Step in the same domain is still created", () => {
  const f = fixture();
  try {
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    const different = f.planOne({
      from: ["origin"],
      description:
        "检查管理员导出接口的对象级越权：用公开的项目 id 43/62 请求 /api/admin/projects/{id}，确认是否返回项目名称、评委姓名、评分与附件；只读。",
      property: "未认证请求 admin 单资源接口不返回业务字段，响应与不存在的 id 一致。",
      test_domain: "access",
      focus: "对象级越权",
      priority: 88,
    });
    assert.equal(different.settle.ok, true);
    assert.notEqual(different.plan.steps[0], stepId);
    const graph = f.store.get(f.id);
    assert.equal(graph.steps.length, 2);
    assert.equal(graph.steps.find((step) => step.id === stepId)!.version, 1, "the original Step was left alone");
  } finally {
    f.close();
  }
});

test("an executed Step is never rewritten by a later near-duplicate", () => {
  const f = fixture();
  try {
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    f.execute(stepId);
    const later = f.planOne(accessRefinement);
    assert.equal(later.settle.ok, true);
    assert.notEqual(later.plan.steps[0], stepId);
    assert.equal(f.store.get(f.id).steps.length, 2);
  } finally {
    f.close();
  }
});

test("Decide can re-ground an unstarted Step in Facts but rejects unknown sources", () => {
  const f = fixture();
  try {
    const recon = f.planOne({
      from: ["origin"],
      description: "对站点做基础信息收集与指纹识别，记录入口与目录结构。",
      property: "完成后能列出指纹与入口。",
      test_domain: "recon",
      focus: "指纹与目录",
      priority: 100,
    });
    f.execute(recon.plan.steps[0]);
    const factId = f.store.get(f.id).facts.find((fact) => fact.id !== "origin")!.id;

    const access = f.planOne(accessStep);
    const stepId = access.plan.steps[0];
    const planner = f.planner();
    const updated = f.submit({
      worker: planner.worker,
      updates: [{ id: stepId, from: [factId], expected_version: 1 }],
    });
    assert.equal(updated.settle.ok, true);
    let step = f.store.get(f.id).steps.find((value) => value.id === stepId)!;
    assert.deepEqual(step.from, [factId]);
    assert.equal(step.version, 2);

    const later = f.planner();
    const blocked = f.submit({
      worker: later.worker,
      updates: [{ id: stepId, from: ["f999"], expected_version: 2 }],
    });
    assert.equal(blocked.settle.ok, false);
    assert.ok(blocked.settle.conflicts.some((conflict) => /Invalid source fact/.test(conflict.reason)));
  } finally {
    f.close();
  }
});

test("Decide can refine an unstarted Step in place, but not after it ran", () => {
  const f = fixture();
  try {
    const first = f.planOne(accessStep);
    const stepId = first.plan.steps[0];
    const planner = f.planner();
    const updated = f.submit({
      worker: planner.worker,
      updates: [
        {
          id: stepId,
          description: "只做 /cms/ 公开查询接口的未授权读取，不测试登录后的管理接口。",
          property: "匿名读取 /cms/ 查询接口只返回公开数据，不返回他人记录。",
          method_hint: "逐条请求 /cms/recentPurchaseDetail 与 /cms/detail，比较匿名与空参数响应。",
          from: ["origin"],
          expected_version: 1,
        },
      ],
    });
    assert.equal(updated.settle.ok, true);
    let step = f.store.get(f.id).steps[0];
    assert.match(step.description, /只做 \/cms\//);
    assert.match(step.property ?? "", /只返回公开数据/);
    assert.match(step.method_hint ?? "", /逐条请求/);
    assert.equal(step.version, 2);
    assert.deepEqual(
      step.edits?.map((edit) => edit.field),
      ["description", "property"],
      "new text on an empty field has no previous value to archive",
    );

    f.execute(stepId);
    const afterRun = f.planner();
    const blocked = f.submit({
      worker: afterRun.worker,
      updates: [{ id: stepId, description: "改写已经执行过的问题", expected_version: 3 }],
    });
    assert.equal(blocked.settle.ok, false);
    assert.ok(
      blocked.settle.conflicts.some((conflict) => conflict.kind === "update" && /已执行/.test(conflict.reason)),
    );
  } finally {
    f.close();
  }
});
