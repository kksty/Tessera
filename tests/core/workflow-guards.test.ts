import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import { projectEntry } from "../../packages/core/src/projection.js";
import { createProjectSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Workflow guards", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const submit = (worker: string, input: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker,
        submission_id: randomUUID(),
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...input,
      }),
    );
  };
  // A deterministic Decide lease: these tests exercise the settlement guards, not
  // the dispatcher's job ordering.
  const takeDecide = () => {
    store.mutate(id, "", false, (g) => {
      g.project.reason = {
        worker: "planner",
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
      };
    });
    return "planner";
  };
  const step = (input: Record<string, unknown> = {}) => ({
    from: ["origin"],
    description: "Inspect /login",
    property: "未授权用户不能读取他人资料",
    ...input,
  });
  const commitStep = (description: string) => {
    const worker = takeDecide();
    return submit(worker, { steps: [step({ description })] }).plan.steps[0];
  };
  return { store, id, submit, takeDecide, step, commitStep };
}

test("one Decide round cannot exceed the new-Step budget, and a rejected plan writes nothing", () => {
  const f = fixture();
  try {
    f.store.stepBudget = { maxNewStepsPerRound: 2, maxOpenSteps: 0 };
    const worker = f.takeDecide();
    const before = f.store.get(f.id);
    assert.throws(
      () =>
        f.submit(worker, {
          steps: [f.step({ description: "A" }), f.step({ description: "B" }), f.step({ description: "C" })],
        }),
      /每轮最多新增 2 个 Step/,
    );
    assert.deepEqual(f.store.get(f.id).steps, before.steps);
  } finally {
    f.store.close();
  }
});

test("a near-duplicate merge does not consume the new-Step budget", () => {
  const f = fixture();
  try {
    f.store.stepBudget = { maxNewStepsPerRound: 1, maxOpenSteps: 0 };
    const worker = f.takeDecide();
    const settle = f.submit(worker, {
      steps: [
        f.step({ description: "Inspect /login 登录入口" }),
        f.step({ description: "Inspect /login 登录入口", property: "未授权用户不能读取他人资料，含验证码分支" }),
      ],
    }).settle;
    assert.equal(settle.ok, true, JSON.stringify(settle.conflicts));
    assert.equal(
      f.store.get(f.id).steps.filter((s) => !s.deleted).length,
      1,
      "the second Step is a near-duplicate and must merge into the first",
    );
  } finally {
    f.store.close();
  }
});

test("the open-Step cap forces closure before new work can be queued", () => {
  const f = fixture();
  try {
    f.store.stepBudget = { maxNewStepsPerRound: 0, maxOpenSteps: 2 };
    f.commitStep("A");
    f.commitStep("B");
    const worker = f.takeDecide();
    assert.throws(() => f.submit(worker, { steps: [f.step({ description: "C" })] }), /在途 Step 已达上限 3\/2/);
    assert.equal(f.store.get(f.id).steps.filter((s) => !s.concluded_at && !s.discarded).length, 2);
  } finally {
    f.store.close();
  }
});

test("an open lead is advisory and no longer blocks completion", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "", false, (g) => {
      g.leads = [
        {
          id: "l001",
          surface: "example.test/login",
          why: "参数可能可注入",
          suggested_property: "参数不能改变查询语义",
          evidence_ids: [],
          status: "open",
          created_by: "worker",
          created_at: new Date().toISOString(),
        },
      ];
    });
    const worker = f.takeDecide();
    const settle = f.submit(worker, {
      complete: { from: ["origin"], description: "范围已覆盖，无更多有价值工作" },
    }).settle;
    assert.equal(settle.ok, true, JSON.stringify(settle.conflicts));
    assert.equal(settle.completed, true);
    assert.equal(f.store.get(f.id).leads![0].status, "open");
  } finally {
    f.store.close();
  }
});

test("a negative claim missing provenance is rejected at write time, not at review", () => {
  const f = fixture();
  try {
    const planned = f.commitStep("Probe absence");
    f.store.mutate(f.id, "", false, (g) => {
      g.steps.find((s) => s.id === planned)!.worker = "w1";
    });
    assert.throws(
      () =>
        f.store.fact(f.id, planned, {
          worker: "w1",
          description: "参数 a 无注入",
          status: "not_observed",
          evidence_ids: [],
        }),
      /负向观测被拒绝.*request/,
    );
    assert.throws(
      () =>
        f.store.fact(f.id, planned, {
          worker: "w1",
          description: "参数 a 无注入",
          status: "not_observed",
          request: { method: "GET", url: "https://example.test/login?a=1&b=2" },
          parameter_sources: [{ parameter: "a", source: "表单", evidence_ids: [] }],
          evidence_ids: [],
        }),
      /负向观测被拒绝.*b/,
    );
    const accepted = f.store.fact(f.id, planned, {
      worker: "w1",
      description: "参数 a、b 无注入",
      status: "not_observed",
      request: { method: "GET", url: "https://example.test/login?a=1&b=2" },
      parameter_sources: [
        { parameter: "a", source: "表单", evidence_ids: [] },
        { parameter: "b", source: "页面 JS", evidence_ids: [] },
      ],
      evidence_ids: [],
    });
    assert.equal(accepted.status, "not_observed");
    assert.equal(accepted.negative_claim_version, 1);
  } finally {
    f.store.close();
  }
});

test("revise_fact fixes a Fact in place and keeps the replaced text", () => {
  const f = fixture();
  try {
    const planned = f.commitStep("Count identities");
    f.store.mutate(f.id, "", false, (g) => {
      g.steps.find((s) => s.id === planned)!.worker = "w1";
    });
    const fact = f.store.fact(f.id, planned, {
      worker: "w1",
      description: "共 5 个身份证号",
      conclusion: "共 5 个身份证号",
      evidence_ids: [],
    });
    const revised = f.store.reviseFact(f.id, fact.id, {
      worker: "w1",
      description: "共 4 个身份证号",
      conclusion: "共 4 个身份证号",
    });
    assert.equal(revised.description, "共 4 个身份证号");
    assert.equal(revised.conclusion, "共 4 个身份证号");
    assert.deepEqual(
      (revised.edits ?? []).map((e) => e.field),
      ["description", "conclusion"],
    );
    assert.equal(revised.edits![0].from, "共 5 个身份证号");
    // A revision creates no Step and no new Fact.
    assert.equal(f.store.get(f.id).steps.filter((s) => !s.deleted).length, 1);
    assert.equal(f.store.get(f.id).facts.filter((x) => x.id !== "origin").length, 1);
  } finally {
    f.store.close();
  }
});

test("revise_fact refuses the origin Fact and provenance-erasing edits on a negative claim", () => {
  const f = fixture();
  try {
    const planned = f.commitStep("Probe absence again");
    f.store.mutate(f.id, "", false, (g) => {
      g.steps.find((s) => s.id === planned)!.worker = "w1";
    });
    assert.throws(() => f.store.reviseFact(f.id, "origin", { worker: "w1", description: "x" }), /origin/);
    const negative = f.store.fact(f.id, planned, {
      worker: "w1",
      description: "参数 a 无注入",
      status: "not_observed",
      request: { method: "GET", url: "https://example.test/login?a=1" },
      parameter_sources: [{ parameter: "a", source: "表单", evidence_ids: [] }],
      evidence_ids: [],
    });
    assert.throws(() => f.store.reviseFact(f.id, negative.id, { worker: "w1", parameter_sources: [] }), /负向观测被拒绝/);
  } finally {
    f.store.close();
  }
});

test("the Decide entry carries per-Step cost and yield", () => {
  const f = fixture();
  try {
    const entry = projectEntry(f.store.get(f.id), "origin") as Record<string, any>;
    assert.ok("step_costs" in entry);
    assert.equal(entry.step_costs.total_input, 0);
    assert.deepEqual(entry.step_costs.steps, []);
    assert.equal(entry.open_leads_total, 0);
    assert.equal(entry.control.confirmed_informational, 0);
  } finally {
    f.store.close();
  }
});
