import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { createProjectSchema, submitDecisionsSchema, type Job } from "../../packages/protocol/src/index.js";

function project(store: Store, extra: Record<string, unknown> = {}) {
  const graph = store.create(
    createProjectSchema.parse({
      title: "Scope",
      origin: "https://old.test",
      goal: "旧目标",
      ...extra,
    }),
  );
  return graph.project.id;
}

/** A Decide submission carrying the current snapshot. */
function decider(store: Store, id: string, worker: string) {
  const job = store.claim(id, worker, 0)!;
  assert.equal(job.kind, "decide");
  return (body: Record<string, unknown>) => {
    const g = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker: job.worker,
        graph_id: "main",
        revision: g.revision,
        observation_revision: g.observation_revision,
        planning_revision: g.planning_revision,
        ...body,
      }),
    );
  };
}

test("a stopped project's goal can be rewritten, and the next Decide reads the new wording", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    store.status(id, "stopped");
    const before = store.get(id);
    store.editGoal(id, "goal", "拿到域控管理员权限");
    const current = store.get(id);
    const goal = current.goals.find((g) => g.id === "goal")!;
    assert.equal(goal.description, "拿到域控管理员权限");
    assert.equal(goal.edits?.[0].from, "旧目标");
    assert.equal(current.project.status, "stopped", "保存文本不会替用户解除暂停");
    assert.ok(current.revision > before.revision);
    assert.ok(current.observation_revision > before.observation_revision, "改写会唤醒下一次 Decide");
    assert.equal(store.claim(id, "idle", 0), null, "暂停的项目仍然没有可领取任务");

    // Resuming the same wording also works (the button is 保存并继续).
    store.editGoal(id, "goal", "拿到域控管理员权限", { resume: true });
    assert.equal(store.get(id).project.status, "active");
    const job = store.claim(id, "planner", 0)!;
    const view = memoryEntry(store.get(id), job, undefined) as any;
    assert.equal(view.goal, "拿到域控管理员权限");
    assert.ok(store.events(id).some((e) => e.kind === "goal.edited"));
    assert.throws(() => store.editGoal(id, "goal", "   "), /不能为空/);
  } finally {
    store.close();
  }
});

test("a completed project refuses a rewrite with an actionable message", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const submit = decider(store, id, "planner");
    assert.equal(submit({ submission_id: "c1", complete: { from: ["origin"], description: "完成" } }).settle.ok, true);
    assert.equal(store.get(id).project.status, "completed");
    assert.throws(() => store.editGoal(id, "goal", "新目标"), /已完成/);
    assert.throws(() => store.editOrigin(id, "https://new.test"), /已完成/);
  } finally {
    store.close();
  }
});

test("rewriting the origin follows the authorized scope and stops stale origin work", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const oldStep = store.manualStep(id, { from: ["origin"], description: "只扫旧主机", creator: "human" });
    store.status(id, "stopped");
    store.editOrigin(id, "https://new.test", { resume: true });
    const current = store.get(id);
    assert.equal(current.project.status, "active");
    const origin = current.facts.find((f) => f.id === "origin")!;
    assert.equal(origin.description, "https://new.test");
    assert.equal(origin.conclusion, "目标资产：https://new.test");
    assert.equal(origin.edits?.[0].from, "https://old.test");
    const asset = current.assets.find((a) => a.id === origin.asset_id)!;
    assert.equal(asset.hostname, "new.test");
    assert.equal(asset.approval, "approved", "改写起点就是人的范围授权");
    assert.equal(current.assets.find((a) => a.id === "a001")!.cooldown_override, "cooled");
    const stale = current.steps.find((s) => s.id === oldStep.id)!;
    assert.equal(stale.discarded, true);
    assert.match(stale.discard_reason ?? "", /起点已改写/);
    assert.ok(store.events(id).some((e) => e.kind === "origin.edited"));

    const job = store.claim(id, "planner", 0)!;
    const view = memoryEntry(store.get(id), job, undefined) as any;
    assert.match(view.facts.join("\n"), /https:\/\/new\.test/);
    assert.throws(() => store.editOrigin(id, "   "), /不能为空/);
  } finally {
    store.close();
  }
});

test("Hints enter the Decide view sorted by weight, with coverage, and block completion until answered", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store, {
      hints: [
        { content: "低权重提示", priority: 1 },
        { content: "高权重提示：先看登录页再扫端口", priority: 9 },
      ],
    });
    const submit = decider(store, id, "planner");
    const view = memoryEntry(store.get(id), { kind: "decide" } as Job, undefined) as any;
    assert.deepEqual(view.unaddressed_hints, ["h002", "h001"], "weight, then id");
    assert.match(view.hints[0], /^h002 p9 待人工确认 — 高权重提示：先看登录页再扫端口$/);
    assert.match(view.hints[1], /^h001 p1 待人工确认 — 低权重提示$/);

    const planned = submit({
      submission_id: "p1",
      steps: [{ from: ["origin"], description: "检查登录页", hint_ids: ["h002"] }],
    });
    assert.equal(planned.settle.ok, true);
    const covered = memoryEntry(store.get(id), { kind: "decide" } as Job, undefined) as any;
    assert.match(covered.hints[0], /→ s001.*仍待人工确认/);
    assert.deepEqual(covered.unaddressed_hints, ["h001"]);
    assert.deepEqual(covered.unresolved_hints, ["h002", "h001"]);

    // A new human nudge opens the next round; the completion must answer it too.
    store.hint(id, "再确认一次", "human", 0);
    const submit2 = decider(store, id, "planner-2");
    const close = { id: "s001", reason: "登录页已检查", evidence_ids: [], expected_version: 1 };
    const refused = submit2({
      submission_id: "c1",
      closes: [close],
      complete: { from: ["origin"], description: "完成" },
    });
    assert.equal(refused.settle.ok, false);
    assert.match(refused.settle.conflicts[0].reason, /Hint 需人工确认.*h001, h002, h003/);
    assert.equal(store.get(id).hints.find((h) => h.id === "h001")!.resolved, undefined);

    // A model note is advice: it cannot close the directive, so the same batch
    // is still rejected. (A successful note-only settlement is covered in hints.test.)
    const noted = submit2({
      submission_id: "c2",
      closes: [close],
      hint_notes: [
        { id: "h001", note: "本轮不需要低权重提示" },
        { id: "h003", note: "已按要求确认" },
      ],
      complete: { from: ["origin"], description: "完成" },
    });
    assert.equal(noted.settle.ok, false);
    assert.equal(store.get(id).hints.find((h) => h.id === "h001")!.resolved, undefined);

    for (const hintId of ["h001", "h002", "h003"]) store.resolveHint(id, hintId, { note: "人工确认" });
    const accepted = submit2({
      submission_id: "c3",
      closes: [close],
      complete: { from: ["origin"], description: "完成" },
    });
    assert.equal(accepted.settle.ok, true);
    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.hints.find((h) => h.id === "h001")!.resolved?.note, "人工确认");
  } finally {
    store.close();
  }
});
