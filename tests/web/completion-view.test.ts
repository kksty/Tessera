import { test } from "node:test";
import assert from "node:assert/strict";
import type { Graph, Step } from "../../packages/protocol/src/index.js";
import { completionSnapshot, coverageCounts, coverageRows } from "../../apps/web/src/completion-view.js";

const step = (patch: Partial<Step>): Step => ({
  id: "s001",
  from: ["origin"],
  to: null,
  description: "任务",
  priority: 0,
  discarded: false,
  creator: "planner",
  worker: null,
  last_heartbeat_at: null,
  created_at: "2026-10-23T00:00:00.000Z",
  concluded_at: null,
  fact_ids: [],
  summary: "",
  graph_id: "main",
  attempts: 0,
  ...patch,
});

function graph(patch: Partial<Graph> = {}): Graph {
  const base = {
    format_version: 1,
    project: {
      id: "proj_view",
      title: "View",
      status: "completed",
      created_at: "2026-10-23T00:00:00.000Z",
      reason: null,
    },
    revision: 1,
    observation_revision: 1,
    decided_revision: 1,
    last_observation_at: "2026-10-23T00:00:00.000Z",
    facts: [
      { id: "origin", description: "https://example.test", graph_id: "main", evidence_ids: [] },
      {
        id: "f001",
        description: "观测",
        graph_id: "main",
        evidence_ids: ["e001"],
        objects: ["https://example.test/a", "/b", "https://example.test/d"],
      },
    ],
    goals: [],
    steps: [],
    hints: [],
    findings: [],
    assets: [],
    evidence: [
      {
        id: "e001",
        title: "证据",
        mime_type: "text/plain",
        size: 1,
        sha256: "hash",
        created_at: "2026-10-23T00:00:00.000Z",
      },
    ],
    reviews: [],
    usage: [],
  };
  return { ...base, ...patch } as unknown as Graph;
}

test("coverage rows keep recorded dispositions and expose observed but unrecorded surfaces", () => {
  const recorded = [
    { surface: "https://example.test/a", status: "tested" as const, evidence_ids: ["e001"] },
    { surface: "/b", status: "waived" as const, reason: "接口已下线", evidence_ids: [] },
    { surface: "example.test/c", status: "na" as const, reason: "不存在该路径", evidence_ids: [] },
  ];
  const rows = coverageRows(graph(), recorded);
  assert.deepEqual(
    rows.map((row) => [row.surface, row.parameter ?? "", row.status, row.reason ?? ""]),
    [
      ["example.test/a", "", "tested", ""],
      ["example.test/b", "", "waived", "接口已下线"],
      ["example.test/c", "", "na", "不存在该路径"],
      ["example.test/d", "", "unrecorded", ""],
    ],
  );
  assert.equal(rows.find((row) => row.surface === "example.test/a")?.fact_ids[0], "f001");
  assert.equal(rows.find((row) => row.surface === "example.test/c")?.observed, false);
  assert.deepEqual(coverageCounts(rows), { total: 4, tested: 1, waived: 1, na: 1, unrecorded: 1 });
});

test("per-parameter rows stay distinct while a surface-level row covers the surface", () => {
  const rows = coverageRows(graph(), [
    { surface: "example.test/a", parameter: "id", status: "tested", evidence_ids: ["e001"] },
    { surface: "example.test/a", parameter: "name", status: "tested", evidence_ids: ["e001"] },
  ]);
  assert.equal(rows.filter((row) => row.surface === "example.test/a" && row.status === "tested").length, 2);
  assert.ok(!rows.some((row) => row.status === "unrecorded" && row.surface === "example.test/a"));
});

test("completion snapshot prefers a pending proposal, then the last completion Step", () => {
  const pending = graph({
    project: {
      id: "proj_view",
      title: "View",
      status: "active",
      created_at: "2026-10-23T00:00:00.000Z",
      reason: null,
      pending_completion: {
        from: ["origin"],
        description: "完成",
        coverage: [{ surface: "example.test/a", status: "tested", evidence_ids: ["e001"] }],
        graph_id: "main",
        worker: "planner",
        observation_revision: 1,
      },
    },
  });
  const proposed = completionSnapshot(pending);
  assert.equal(proposed.pending, true);
  assert.equal(proposed.entries.length, 1);

  const completed = graph({
    steps: [
      step({ id: "s001", to: "goal", concluded_at: "2026-10-23T00:00:00.000Z", completion: { coverage: [] } }),
      step({
        id: "s002",
        to: "goal",
        concluded_at: "2026-10-23T01:00:00.000Z",
        completion: {
          coverage: [{ surface: "example.test/b", status: "waived", reason: "下线", evidence_ids: [] }],
        },
      }),
    ],
  });
  const final = completionSnapshot(completed);
  assert.equal(final.pending, false);
  assert.equal(final.step?.id, "s002");
  assert.equal(final.entries[0]?.surface, "example.test/b");

  const legacy = graph({
    steps: [step({ id: "s009", to: "goal", concluded_at: "2026-10-23T00:00:00.000Z" })],
  });
  const historical = completionSnapshot(legacy);
  assert.deepEqual(historical.entries, []);
  assert.equal(historical.step?.id, "s009");
});
