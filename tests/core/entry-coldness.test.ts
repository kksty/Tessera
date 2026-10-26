import { test } from "node:test";
import assert from "node:assert/strict";
import { COLD_SAMPLE_LIMIT, projectEntry } from "../../packages/core/src/projection.js";
import type { Graph } from "../../packages/protocol/src/index.js";

const project = (round = 50, hot_limit = 200, hot_char_limit?: number) => ({
  id: "p",
  hot_limit,
  ...(hot_char_limit === undefined ? {} : { hot_char_limit }),
  decision_round: round,
  status: "active",
});

function graph(facts: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    format_version: 1 as const,
    project: project(),
    revision: 10,
    observation_revision: 10,
    decided_revision: 9,
    facts,
    steps: [],
    findings: [],
    goals: [{ id: "goal", description: "目标", state: "active" }],
    hints: [],
    assets: [],
    evidence: [],
    reviews: [],
    bookmarks: [],
    ...overrides,
  } as unknown as Graph;
}

const fact = (i: number, lastReferenced: number) => ({
  id: `f${String(i).padStart(3, "0")}`,
  description: `事实 ${i}：端口 8080 开放，返回 200。`,
  conclusion: `事实 ${i} 结论`,
  status: "observed",
  evidence_ids: [],
  last_referenced_round: lastReferenced,
  graph_id: "main",
});

const finding = (i: number, lastReferenced: number) => ({
  id: `v${String(i).padStart(3, "0")}`,
  title: `越权访问 ${i}`,
  description: `无需登录即可访问管理页。更多细节 ${i}。`,
  evidence: "",
  evidence_ids: ["e001"],
  kind: "informational",
  from: ["origin"],
  status: "confirmed",
  version: 1,
  reviewed_version: 1,
  review_status: "pass",
  created_at: "2026-01-01T00:00:00.000Z",
  graph_id: "main",
  severity: null,
  cvss: null,
  last_referenced_round: lastReferenced,
});

const step = (lastReferenced: number) => ({
  id: "s001",
  from: [],
  to: null,
  description: "检查越权",
  priority: 1,
  version: 1,
  discarded: false,
  creator: "fixture",
  worker: null,
  last_heartbeat_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  concluded_at: "2026-01-02T00:00:00.000Z",
  close_reason: "已确认越权。",
  fact_ids: [],
  summary: "",
  graph_id: "main",
  attempts: 1,
  last_referenced_round: lastReferenced,
});

const ids = (entry: Record<string, any>) => entry.cold.sample.map((line: string) => line.split(" ")[0]);

test("热节点上限只让最近的 Facts 进入口，其余进冷区预览", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const stale = Array.from({ length: 300 }, (_, i) => fact(i + 1, 1));
  const entry = projectEntry(graph([origin, ...stale]), "goal") as Record<string, any>;
  // Origin is always shown; the hot budget keeps the first 200 by id (creation tie).
  assert.equal(entry.facts.length, 201);
  assert.equal(entry.facts[0].split(" ")[0], "origin");
  assert.equal(entry.cold.count, 100);
  assert.equal(entry.cold.sample.length, COLD_SAMPLE_LIMIT);
  for (const line of entry.cold.sample) assert.match(line, /^f2\d{2} r1 — 事实 \d+ 结论$/);
  assert.equal(new Set(ids(entry)).size, COLD_SAMPLE_LIMIT, "no repeated preview rows");
  assert.match(entry.cold.hint, /热节点上限 200/);
});

test("冷区预览按决策轮轮换，冷节点不会永远看不见", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const stale = Array.from({ length: 50 }, (_, i) => fact(i + 1, 1));
  const at = (round: number) =>
    projectEntry(graph([origin, ...stale], { project: project(round, 10) }), "goal") as Record<string, any>;
  assert.notDeepEqual(ids(at(10)), ids(at(11)), "the window advances with the decision round");
  const seen = new Set<string>();
  for (let round = 10; round < 10 + 40 / COLD_SAMPLE_LIMIT; round++) for (const id of ids(at(round))) seen.add(id);
  assert.equal(seen.size, 40, "five windows cover every cold fact");
});

test("最近引用过的旧事实保持可见，不占冷区", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const recent = fact(1, 49);
  const entry = projectEntry(graph([origin, recent]), "goal") as Record<string, any>;
  assert.equal(entry.facts.length, 2);
  assert.equal(entry.cold.count, 0);
  assert.deepEqual(entry.cold.sample, []);
});

test("冷区只覆盖超出热预算的 Fact/Finding；已关闭 Step 与证据不算冷", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const coldFinding = finding(1, 1);
  const hotFinding = finding(2, 49);
  const openStep = { ...step(1), id: "s002", concluded_at: null, close_reason: undefined };
  const openFinding = { ...finding(3, 1), step_id: "s002" };
  const entry = projectEntry(
    graph([origin, fact(1, 1)], {
      project: project(50, 1),
      findings: [coldFinding, hotFinding, openFinding],
      steps: [step(1), openStep],
      evidence: [
        {
          id: "e001",
          title: "原始响应",
          mime_type: "text/plain",
          size: 42,
          sha256: "x",
          created_at: "2026-01-01T00:00:00.000Z",
          last_referenced_round: 1,
        },
      ],
    }),
    "goal",
  ) as Record<string, any>;
  assert.equal(entry.cold.count, 2, "only the over-budget Fact and Finding are cold");
  assert.equal(entry.evidence.total, 1, "Evidence is still counted by evidence.total");
  assert.deepEqual(
    entry.findings.map((line: string) => line.split(" ")[0]),
    ["v002", "v003"],
    "the hottest Finding and the Finding of an open Step stay",
  );
  assert.ok(!entry.cold.sample.some((line: string) => line.startsWith("v003 ")), "an open Step's Finding is not cold");
  assert.ok(!entry.cold.sample.some((line: string) => line.startsWith("e001 ")), "Evidence is not in the cold preview");
  assert.ok(
    !entry.cold.sample.some((line: string) => line.startsWith("s001 ")),
    "a closed Step is not in the cold preview",
  );
  assert.ok(entry.cold.sample.includes("f001 r1 — 事实 1 结论"));
  assert.ok(entry.cold.sample.includes("v001 r1 — 越权访问 1：无需登录即可访问管理页。更多细节 1。"));
});

test("从未引用的节点超出上限时标为未引用，仍可检索", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const entry = projectEntry(graph([origin, fact(1, 49), fact(2, -1)], { project: project(50, 1) }), "goal") as Record<
    string,
    any
  >;
  assert.equal(entry.cold.count, 1);
  assert.match(entry.cold.sample[0], /^f002 未引用 — 事实 2 结论$/);
});

test("hot_limit=0 时关闭冷却，所有事实照常出现", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const stale = [fact(1, 1), fact(2, 1)];
  const entry = projectEntry(graph([origin, ...stale], { project: project(50, 0) }), "goal") as Record<string, any>;
  assert.equal(entry.facts.length, 3);
  assert.equal(entry.cold.count, 0);
  assert.deepEqual(entry.cold.sample, []);
  assert.match(entry.cold.hint, /冷却已关闭/);
});

test("字符预算先于节点预算触发冷却", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const long = (i: number) => ({ ...fact(i, 49 - i), description: `事实 ${i}：${"很长的结论".repeat(200)}` });
  const facts = Array.from({ length: 8 }, (_, i) => long(i + 1));
  // Node budget is generous; the character budget is what cools the tail.
  const entry = projectEntry(graph([origin, ...facts], { project: project(50, 40, 1_000) }), "goal") as Record<
    string,
    any
  >;
  assert.ok(entry.cold.count > 0, "long lines cool before the node limit is reached");
  assert.ok(entry.cold.hot.chars <= 1_000);
  assert.equal(entry.cold.hot.nodes + entry.cold.count, 8);
  assert.match(entry.cold.hint, /1000 字符/);
});

test("必显集合超预算时不隐藏，只标记 over_budget", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const inputs = ["f001", "f002", "f003"].map((id, i) => ({ ...fact(i + 1, 1), id, description: `必显 ${i}` }));
  const focusStep = {
    ...step(1),
    id: "s010",
    concluded_at: null,
    close_reason: undefined,
    from: ["f001", "f002", "f003"],
  };
  const entry = projectEntry(
    graph([origin, ...inputs], { steps: [focusStep], project: project(50, 2, 40) }),
    "s010",
  ) as Record<string, any>;
  assert.equal(entry.cold.hot.mandatory, 3);
  assert.equal(entry.cold.hot.over_budget, true);
  assert.equal(entry.cold.count, 0, "mandatory facts stay hot even when over budget");
  assert.match(entry.cold.hint, /超出预算/);
});

test("旧项目缺省 hot_limit 仍按 200 读取，新项目由 store 写入 80", () => {
  const origin = { ...fact(0, 49), id: "origin", description: "https://seed.test" };
  const stale = Array.from({ length: 250 }, (_, i) => fact(i + 1, 1));
  const legacy = graph([origin, ...stale], { project: { id: "p", decision_round: 50, status: "active" } });
  const entry = projectEntry(legacy, "goal") as Record<string, any>;
  assert.equal(entry.cold.hot.nodes, 200, "legacy graphs keep the historical 200-node window");
  assert.equal(entry.cold.count, 50);
});
