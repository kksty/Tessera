import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run, Step } from "../../packages/protocol/src/index.js";
import { runAttention, runOutcome, unsettledRun } from "../../apps/web/src/run-state.js";

const run = (patch: Partial<Run> = {}): Run => ({
  id: "run_1",
  project_id: "proj",
  kind: "execute",
  worker: "w_1",
  graph_id: "main",
  node_id: "s001",
  attempt: 1,
  status: "needs_attention",
  started_at: "2026-10-20T14:24:25.534Z",
  heartbeat_at: "2026-10-20T14:33:30.463Z",
  finished_at: "2026-10-20T14:33:32.412Z",
  external_action_possible: true,
  input: null,
  output: null,
  cost: null,
  request_count: 0,
  ...patch,
});

const step = (patch: Partial<Step> = {}): Step => ({
  id: "s001",
  from: ["origin"],
  to: null,
  description: "指纹识别",
  priority: 1,
  discarded: false,
  creator: "planner",
  worker: null,
  last_heartbeat_at: null,
  created_at: "2026-10-20T14:24:24.449Z",
  concluded_at: null,
  fact_ids: [],
  summary: "",
  graph_id: "main",
  attempts: 1,
  ...patch,
});

test("a blocked Step is the only thing that keeps a failed Run actionable", () => {
  const attention = runAttention(run(), step({ blocked_run_id: "run_1" }));
  assert.equal(attention?.actionable, true);
  assert.equal(attention?.label, "需人工检查");

  const closed = runAttention(run(), step({ blocked_run_id: "run_1", concluded_at: "2026-10-20T14:38:14.523Z" }));
  assert.equal(closed?.actionable, false);
  assert.match(closed!.note, /已关闭，此运行无需重试/);
  assert.equal(unsettledRun(run(), step({ blocked_run_id: "run_1", concluded_at: "2026-10-20T14:38:14.523Z" })), false);
});

test("a settled Run never asks for a retry again", () => {
  const settled = runAttention(
    run({ resolved_by: "operator", resolved_at: "2026-10-20T14:40:00.000Z" }),
    step({ blocked_run_id: "run_1" }),
  );
  assert.equal(settled?.actionable, false);
  assert.match(settled!.note, /已由人工确认重试/);
  assert.equal(
    unsettledRun(run({ resolved_at: "2026-10-20T14:40:00.000Z" }), step({ blocked_run_id: "run_1" })),
    false,
  );
});

test("a Run is not actionable when its Step is gone, superseded or already claimed", () => {
  assert.equal(runAttention(run(), undefined)?.actionable, false);
  assert.equal(
    runAttention(
      run(),
      step({
        deleted: {
          at: "2026-10-20T14:40:00.000Z",
          by: "human",
          submission_id: "human_1",
          reason: "重复",
          root_id: "s001",
          cascade: "none",
        },
      }),
    )?.actionable,
    false,
  );
  assert.equal(runAttention(run(), step({ blocked_run_id: "run_2" }))?.actionable, false);
  assert.equal(runAttention(run(), step({ worker: "w_2" }))?.actionable, false);
  assert.equal(runAttention(run({ status: "succeeded" }), step()), null);
});

test("a failed Run is history once a later attempt takes over", () => {
  const failed = run({
    kind: "decide",
    node_id: "main",
    attempt: 37,
    status: "failed",
    external_action_possible: false,
  });
  const latest = run({
    id: "run_39",
    kind: "decide",
    node_id: "main",
    attempt: 39,
    status: "running",
    external_action_possible: false,
  });
  const superseded = runOutcome(failed, undefined, { latest, projectStatus: "active" });
  assert.equal(superseded?.label, "已被第 39 次接管");
  assert.equal(superseded?.tone, "neutral");
  assert.match(superseded!.note, /仅留档/);

  assert.equal(runOutcome(failed, undefined, { projectStatus: "stopped" })?.label, "项目已暂停");
  assert.equal(runOutcome(failed, undefined, { projectStatus: "stopped" })?.tone, "warn");
  assert.equal(runOutcome(failed, undefined, { projectStatus: "active" })?.label, "等待自动重试");
  assert.equal(runOutcome(failed, undefined, { projectStatus: "completed" }), null);
  assert.equal(runOutcome(run({ status: "succeeded" }), step(), { projectStatus: "active" }), null);
});

test("a failed Execute whose Step was closed is history, not a queued retry", () => {
  const failed = run({ status: "failed" });
  assert.equal(
    runOutcome(failed, step({ concluded_at: "2026-10-20T14:40:00.000Z" }), { projectStatus: "active" })?.label,
    "已处理",
  );
  assert.equal(
    runOutcome(failed, step({ concluded_at: "2026-10-20T14:40:00.000Z" }), { projectStatus: "active" })?.note,
    "任务 s001 已关闭，此运行仅留档。",
  );
  assert.equal(
    runOutcome(failed, step({ discarded: true }), { projectStatus: "active" })?.note,
    "任务 s001 已废弃，此运行仅留档。",
  );
});

test("the human gate still outranks a later automatic attempt", () => {
  const latest = run({ id: "run_2", attempt: 2, status: "running" });
  const outcome = runOutcome(run(), step({ blocked_run_id: "run_1" }), {
    latest,
    projectStatus: "active",
  });
  assert.equal(outcome?.label, "需人工检查");
  assert.equal(outcome?.tone, "danger");
});
