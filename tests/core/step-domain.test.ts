import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import {
  TEST_DOMAINS,
  createProjectSchema,
  stepFocusSchema,
  submitDecisionsSchema,
  testDomainSchema,
} from "../../packages/protocol/src/index.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Test domains", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const submit = (body: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        graph_id: "main",
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...body,
      }),
    );
  };
  /** A new observation starts a fresh Decide lease even when unclaimed Steps exist. */
  const planner = () => {
    store.hint(id, `决策轮次 ${store.get(id).project.decision_round ?? 0}`);
    const job = store.claim(id, "planner", 0);
    assert.ok(job && job.kind === "decide");
    return job!;
  };
  return { store, id, submit, planner };
}

test("测试域是固定枚举，focus 有长度上限，旧客户端可以不填", () => {
  assert.equal(TEST_DOMAINS.length, 10, "九个核心域加 other");
  for (const domain of TEST_DOMAINS) assert.equal(testDomainSchema.parse(domain), domain);
  assert.throws(() => testDomainSchema.parse("web"), "不允许自造顶层分类");
  assert.throws(() => testDomainSchema.parse(""));
  assert.equal(stepFocusSchema.parse("  提权：SUID  "), "提权：SUID");
  assert.throws(() => stepFocusSchema.parse("x".repeat(21)));

  const legacy = submitDecisionsSchema.parse({
    submission_id: "legacy",
    worker: "planner",
    revision: 0,
    observation_revision: 0,
  });
  assert.deepEqual(legacy.steps, [], "没有分类字段的旧客户端仍能提交");
});

test("Decide 规划的新 Step 持久化 test_domain 与 focus", () => {
  const f = fixture();
  try {
    const job = f.planner();
    const response = f.submit({
      submission_id: "plan-domain-1",
      worker: job.worker,
      steps: [
        { from: ["origin"], description: "Enumerate subdomains", test_domain: "recon", focus: "资产：子域枚举" },
        { from: ["origin"], description: "Try the login form", test_domain: "auth" },
      ],
    });
    assert.equal(response.plan.steps.length, 2);
    const graph = f.store.get(f.id);
    const [recon, auth] = response.plan.steps.map((stepId) => graph.steps.find((s) => s.id === stepId)!);
    assert.equal(recon.test_domain, "recon");
    assert.equal(recon.focus, "资产：子域枚举");
    assert.equal(auth.test_domain, "auth");
    assert.equal(auth.focus, undefined, "focus 是可选项，不强制每个 Step 都写");

    // 事实由生产 Step 归组：step_id 是继承依据，Fact 不单独落分类字段。
    f.store.manualHeartbeat(f.id, recon.id, "human");
    const fact = f.store.fact(f.id, recon.id, {
      worker: "human",
      description: "admin.example.test resolves",
      evidence_ids: [],
    });
    assert.equal(fact.step_id, recon.id);
    assert.equal("test_domain" in fact, false);
  } finally {
    f.store.close();
  }
});

test("更新旧 Step 可以补分类，不改版本也不触发重新规划", () => {
  const f = fixture();
  try {
    const first = f.planner();
    const planned = f.submit({
      submission_id: "plan-legacy-1",
      worker: first.worker,
      steps: [{ from: ["origin"], description: "Probe the search box" }],
    });
    const stepId = planned.plan.steps[0];
    const before = f.store.get(f.id);
    const version = before.steps.find((s) => s.id === stepId)!.version;

    const second = f.planner();
    const planning = f.store.get(f.id).planning_revision;
    const updated = f.submit({
      submission_id: "settle-domain-1",
      worker: second.worker,
      updates: [
        {
          id: stepId,
          expected_version: version,
          test_domain: "inject",
          focus: "注入：反射型",
        },
      ],
    });
    assert.deepEqual(updated.settle.conflicts, []);
    const graph = f.store.get(f.id);
    const step = graph.steps.find((s) => s.id === stepId)!;
    assert.equal(step.test_domain, "inject");
    assert.equal(step.focus, "注入：反射型");
    assert.equal(step.version, version, "分类是标签，不改变 Step 版本");
    assert.equal(graph.planning_revision, planning, "只补分类不应触发重新规划");
  } finally {
    f.store.close();
  }
});

test("人工补分类：不改版本、不推进规划，可清除", () => {
  const f = fixture();
  try {
    const step = f.store.manualStep(f.id, { from: ["origin"], description: "Manual check", creator: "human" });
    const planning = f.store.get(f.id).planning_revision;
    const classified = f.store.classifyStep(f.id, step.id, { test_domain: "recon", focus: "  资产：子域  " });
    assert.equal(classified.test_domain, "recon");
    assert.equal(classified.focus, "资产：子域");

    const graph = f.store.get(f.id);
    const saved = graph.steps.find((s) => s.id === step.id)!;
    assert.equal(saved.version, 1, "人工补分类也不改版本");
    assert.equal(graph.planning_revision, planning, "人工补分类不触发重新规划");
    assert.ok(f.store.events(f.id).some((event) => event.kind === "step.classified"));

    const cleared = f.store.classifyStep(f.id, step.id, { test_domain: null, focus: "" });
    assert.equal(cleared.test_domain, undefined);
    assert.equal(cleared.focus, undefined);
    assert.throws(() => f.store.classifyStep(f.id, "s999", { test_domain: "recon" }), /Step not found/);
  } finally {
    f.store.close();
  }
});

test("Decide 投影在已分类的 Step 行上带 [域]，未分类不带", () => {
  const f = fixture();
  try {
    const job = f.planner();
    f.submit({
      submission_id: "plan-projection-1",
      worker: job.worker,
      steps: [
        { from: ["origin"], description: "Map subdomains", test_domain: "recon" },
        { from: ["origin"], description: "Unclassified probe" },
      ],
    });
    const entry = memoryEntry(f.store.get(f.id), {
      kind: "decide",
      project_id: f.id,
      graph_id: "main",
      worker: "p",
    } as any) as { steps: string[] };
    assert.ok(
      entry.steps.some((line) => line.includes("[recon]")),
      "已分类的 Step 行带短码",
    );
    assert.ok(
      entry.steps.some((line) => line.includes("Unclassified probe") && !line.includes("[recon]")),
      "未分类的 Step 行不带短码",
    );
  } finally {
    f.store.close();
  }
});

test("未知域与超长 focus 会被提交 Schema 拒绝", () => {
  const base = {
    submission_id: "reject",
    worker: "planner",
    revision: 0,
    observation_revision: 0,
  };
  assert.throws(() =>
    submitDecisionsSchema.parse({
      ...base,
      steps: [{ from: ["origin"], description: "x", test_domain: "web" }],
    }),
  );
  assert.throws(() =>
    submitDecisionsSchema.parse({
      ...base,
      steps: [{ from: ["origin"], description: "x", test_domain: "recon", focus: "x".repeat(21) }],
    }),
  );
  assert.throws(() =>
    submitDecisionsSchema.parse({
      ...base,
      updates: [{ id: "s001", expected_version: 1, test_domain: "nope" }],
    }),
  );
});
