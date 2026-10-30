import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  findingSchema,
  resolveGraphRelations,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import cytoscape from "cytoscape";
import { discoveryElements, graphElements } from "../../apps/web/src/Blackboard.js";
import { applyLayout } from "../../apps/web/src/layouts.js";
import { chainElements, scopeSeeds, scopeSize } from "../../apps/web/src/graph-scope.js";
import { blackboardEvents, blackboardIndexAt, replay, replayBoard } from "../../apps/web/src/replay.js";
import { projectActivity, kindLabel } from "../../apps/web/src/project-activity.js";

test("黑板时间线只保留会改变画面的事件，用量与证据归档不产生新的时刻", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Board timeline", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Check login", creator: "human", claim: true });
    store.hint(id, "Also try the password reset flow");
    store.mutate(id, "usage.recorded", false, (g) => {
      g.usage.push({
        id: "u001",
        kind: "execute",
        graph_id: "main",
        node_id: step.id,
        input: 10,
        output: 2,
        cost: null,
        created_at: new Date().toISOString(),
      });
    });
    store.mutate(id, "evidence.saved", false, (g) => {
      g.evidence.push({
        id: "e001",
        title: "tool output",
        mime_type: "text/plain",
        size: 4,
        sha256: "0".repeat(64),
        created_at: new Date().toISOString(),
      });
    });
    // Evidence enters the active graph only when a claim cites it.
    store.fact(id, step.id, {
      worker: "human",
      description: "Login accepts admin/admin",
      evidence_ids: ["e001"],
    });
    // 归档之后还有一次图变化：回放这一时刻应带上期间的全部事件细节。
    store.hint(id, "Check the admin console");
    const events = store.events(id),
      board = blackboardEvents(events);
    assert.ok(events.some((event) => event.kind === "usage.recorded"));
    assert.ok(events.some((event) => event.kind === "evidence.saved"));
    assert.ok(!board.some((event) => event.kind === "usage.recorded"));
    assert.ok(!board.some((event) => event.kind === "evidence.saved"));
    assert.ok(board.some((event) => event.kind === "step.declared"));
    assert.ok(board.some((event) => event.kind === "fact.observed"));
    assert.ok(board.some((event) => event.kind === "hint.added"));
    assert.equal(board[0].kind, "project.created", "回放仍从建图快照开始");
    // 时间线只按图变化停靠，但重建图仍应用该时刻之前的完整事件。
    const replayed = replayBoard(events, board, board.length - 1)!;
    assert.equal(replayed.usage.length, 1, "回放应带回期间记录的用量");
    assert.equal(replayed.evidence.length, 1, "回放应带回期间归档的证据");
    // 项目时间线里的非图形事件回放到「此前最近一次图变化」。
    const usageSeq = events.find((event) => event.kind === "usage.recorded")!.seq;
    const at = blackboardIndexAt(board, usageSeq);
    assert.ok(at >= 0 && board[at].seq < usageSeq);
    assert.equal(blackboardIndexAt(board, board[0].seq - 1), -1);
  } finally {
    store.close();
  }
});

test("删除前后的事件回放保留各时点图，当前时间线只标记实际删除且不复述旧正文", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Deletion replay", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const job = store.claim(id, "planner", 0)!,
      read = store.get(id);
    store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker: job.worker,
        submission_id: "plan",
        revision: read.revision,
        observation_revision: read.observation_revision,
        planning_revision: read.planning_revision,
        steps: [{ from: ["origin"], description: "REMOVED_REPLAY_BODY" }],
      }),
      job.run_id,
    );
    const before = store.events(id).length - 1;
    store.hint(id, "Prune the obsolete branch");
    const next = store.claim(id, "next-planner", 0)!;
    const current = store.get(id),
      step = current.steps[0];
    store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker: next.worker,
        submission_id: "delete",
        revision: current.revision,
        observation_revision: current.observation_revision,
        planning_revision: current.planning_revision,
        delete_nodes: [{ id: step.id, reason: "Remove this direction" }],
      }),
      next.run_id,
    );
    const events = store.events(id);
    assert.ok(replay(events, before)!.steps.some((s) => s.id === step.id));
    assert.ok(!replay(events, events.length - 1)!.steps.some((s) => s.id === step.id));
    const activity = projectActivity(events, store.get(id), true);
    assert.equal(activity.filter((row) => row.title.startsWith("工作图已删除")).length, 1);
    assert.ok(!JSON.stringify(activity).includes("REMOVED_REPLAY_BODY"));
  } finally {
    store.close();
  }
});

test("项目时间线的每一步都用中文描述，不把 decide.planned 这类事件类型直接显示出来", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Chinese timeline", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const job = store.claim(id, "planner", 0)!,
      read = store.get(id);
    store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker: job.worker,
        submission_id: "plan",
        revision: read.revision,
        observation_revision: read.observation_revision,
        planning_revision: read.planning_revision,
        steps: [{ from: ["origin"], description: "校验登录入口" }],
      }),
      job.run_id,
    );
    const rows = projectActivity(store.events(id), store.get(id), true);
    assert.ok(rows.some((row) => row.kind === "decide.planned"));
    // 默认视图与「全部事件」共用同一条中文标题；未知类型也回落到中文兜底。
    assert.equal(kindLabel("decide.planned"), "提交探索计划");
    // swarm 事件按服务端真实 kind 命名（retire/turn_end/proposed），不能显示成「其他事件」。
    for (const [kind, label] of [
      ["peer.spawn", "执行者裂变"],
      ["peer.retire", "执行者退出"],
      ["peer.message", "执行者消息"],
      ["peer.turn_end", "执行者回合"],
      ["peer.stuck", "执行者停顿"],
      ["peer.retry", "重试执行者"],
      ["round.proposed", "开启完成共识"],
      ["round.opinion", "执行者表态"],
      ["round.committed", "完成共识达成"],
      ["round.invalidated", "完成共识失效"],
    ] as const)
      assert.equal(kindLabel(kind), label);
    assert.equal(kindLabel("some.future.kind"), "其他事件");
    for (const row of rows)
      assert.doesNotMatch(row.title, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i, `事件类型应显示中文：${row.title}`);
  } finally {
    store.close();
  }
});

test("链路视图只保留「来路」：从起点追到当前节点，同层兄弟与后续分支不进画布", () => {
  const elements: { data: Record<string, string> }[] = [
    ...["origin", "a", "b", "c", "goal", "lonely"].map((id) => ({ data: { id } })),
    { data: { id: "oa", source: "origin", target: "a" } },
    { data: { id: "ab", source: "a", target: "b" } },
    { data: { id: "ac", source: "a", target: "c" } },
    { data: { id: "bg", source: "b", target: "goal" } },
  ];
  const ids = (list: { data: Record<string, string> }[]) => list.map((el) => el.data.id);
  // 完整链路：origin → a → b。b 之后的 goal、a 的另一分支 c、以及孤立节点都不属于来路。
  assert.deepEqual(ids(chainElements(elements as any, ["b"])), ["origin", "a", "b", "oa", "ab"]);
  // 限深 1 跳：只带上直接前驱
  assert.deepEqual(ids(chainElements(elements as any, ["b"], 1)), ["a", "b", "ab"]);
  // 没有种子 = 全图；种子都不在图上时也不把画布清空
  assert.equal(chainElements(elements as any, []).length, elements.length);
  assert.equal(chainElements(elements as any, ["nope"]).length, elements.length);
  // 任何深度下都不含悬空边
  for (const depth of [0, 1, 2]) {
    const scoped = chainElements(elements as any, ["a", "c"], depth);
    const nodes = new Set(ids(scoped.filter((el) => !el.data.source) as any));
    for (const edge of scoped.filter((el) => el.data.source))
      assert.ok(nodes.has(edge.data.source) && nodes.has(edge.data.target));
  }
});

test("图展示复用记录的生产关系、兼容多来源并跨图追溯，事件回放不借用当前 Run", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Provenance board", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "First question",
      creator: "human",
      claim: true,
    });
    const fact = store.fact(id, step.id, { worker: "human", description: "Original observation", evidence_ids: [] });
    const observedEvent = store.events(id).findIndex((event) => event.kind === "fact.observed");
    store.manualConclude(id, step.id, "human", "Answered");
    store.reopenStep(id, step.id, { worker: "human", reason: "New run" });
    store.mutate(id, "fixture.cross-graph", false, (graph) => {
      graph.steps[0].graph_id = "old";
      graph.facts.find((item) => item.id === fact.id)!.graph_id = "old";
      // Fact.step_id is authoritative even if an old/partial Step lacks its reverse index.
      graph.steps[0].fact_ids = [];
      graph.steps[0].run_id = "latest-is-not-the-original-run";
    });
    const next = store.manualStep(id, { from: [fact.id], description: "Second question", creator: "human" });
    const graph = store.get(id),
      expanded = graphElements(graph, "main", true);
    assert.ok(expanded.some((edge) => edge.data.source === step.id && edge.data.target === fact.id));
    const chain = chainElements(expanded, [next.id]);
    for (const nodeId of ["origin", step.id, fact.id, next.id])
      assert.ok(chain.some((node) => node.data.id === nodeId));
    assert.equal(
      new Set(expanded.map((element) => element.data.id)).size,
      expanded.length,
      "no duplicate graph element IDs",
    );
    const historical = replay(store.events(id), observedEvent)!;
    assert.equal(historical.steps[0].graph_id, "main");
    assert.equal(resolveGraphRelations(historical).facts.get(fact.id)!.producers[0].run_id, undefined);
    delete graph.facts.find((item) => item.id === fact.id)!.step_id;
    graph.steps[0].fact_ids = [fact.id];
    graph.steps[1].fact_ids = [fact.id];
    const legacy = graphElements(graph, "main", true);
    assert.ok(!legacy.some((edge) => edge.data.source === step.id && edge.data.target === fact.id));
    assert.ok(!legacy.some((edge) => edge.data.source === next.id && edge.data.target === fact.id));
    assert.equal(resolveGraphRelations(graph).facts.get(fact.id)!.ambiguous, false);
  } finally {
    store.close();
  }
});

test("事实节点先显示结论，缺结论时回落正文，推断结论带前缀", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Fact labels", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "枚举药品列表",
      creator: "human",
      claim: true,
    });
    const withConclusion = store.fact(id, step.id, {
      worker: "human",
      description: "目的：把 v011 的药品侧覆盖口径与耗材侧对齐到当前列表，再逐个 companyID 实测。",
      conclusion: "129 个 companyID 全部实测：70 命中 59 空、69 个附件直链",
      evidence_ids: [],
    });
    const inferredOnly = store.fact(id, step.id, {
      worker: "human",
      description: "旧事实只有观测正文",
      evidence_ids: [],
    });
    const elements = graphElements(store.get(id), "main");
    // 标签按字宽换行，断言前先拼回一行。
    const label = (nodeId: string) =>
      String(elements.find((el) => el.data.id === nodeId)!.data.label).replace(/\n/g, "");
    assert.ok(label(withConclusion.id).includes("129 个 companyID 全部实测"), "画布应显示结论");
    assert.ok(!label(withConclusion.id).includes("目的："), "观测正文不占节点");
    assert.ok(label(inferredOnly.id).includes("推断 · 旧事实只有观测正文"), "推断结论要标出来");
    assert.ok(label("origin").startsWith("起点"), "起点仍显示原文");
  } finally {
    store.close();
  }
});

test("范围种子只来自显式范围（主视图点选不改变画布）", () => {
  assert.deepEqual(scopeSeeds({ ids: ["f001"], label: "发现 f001" }), ["f001"]);
  assert.deepEqual(scopeSeeds({ ids: [] }), []);
  assert.deepEqual(scopeSeeds(null), []);
  assert.deepEqual(scopeSeeds(undefined), []);
  const elements = [{ data: { id: "a" } }, { data: { id: "b" } }, { data: { id: "ab", source: "a", target: "b" } }];
  assert.deepEqual(scopeSize(elements as any), { nodes: 2, edges: 1 });
});

test("任务链路显示第一层产出，发现链路停在 Finding，任务保留问号圆圈", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Active chain", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "Verify access",
      creator: "human",
      claim: true,
    });
    const fact = store.fact(id, step.id, { worker: "human", description: "Observed access", evidence_ids: [] });
    const finding = store.submitStepFinding(
      id,
      step.id,
      "human",
      findingSchema.parse({ title: "Access finding", description: "Candidate", from: [fact.id] }),
    );
    const elements = discoveryElements(store.get(id));
    const taskChain = chainElements(elements, [step.id]);
    const terminal = taskChain.find((e) => e.data.id === step.id)!;
    assert.equal(terminal.data.type, "step");
    assert.equal(terminal.data.state, "running");
    assert.equal(terminal.data.label, "?");
    assert.equal(terminal.data.expanded, 0);
    assert.ok(taskChain.some((e) => e.data.source === "origin" && e.data.target === step.id));
    assert.ok(taskChain.some((e) => e.data.id === fact.id));
    assert.ok(taskChain.some((e) => e.data.id === finding.id));
    const later = store.manualStep(id, { from: [fact.id], description: "Later work", creator: "human" });
    assert.ok(!chainElements(discoveryElements(store.get(id)), [step.id]).some((e) => e.data.id === later.id));
    const empty = store.manualStep(id, { from: ["origin"], description: "No results yet", creator: "human" });
    const emptyChain = chainElements(discoveryElements(store.get(id)), [empty.id]);
    assert.ok(!emptyChain.some((e) => e.data.source === empty.id));
    const findingChain = chainElements(elements, [finding.id]);
    assert.ok(findingChain.some((e) => e.data.id === step.id));
    assert.equal(findingChain.find((e) => e.data.id === finding.id)!.data.type, "finding");
    assert.ok(!findingChain.some((e) => e.data.source === finding.id));
  } finally {
    store.close();
  }
});
