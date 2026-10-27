import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { commitPlan } from "../helpers/current-api.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";

const event = (type: string, data: Record<string, unknown>) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  source_id: randomUUID(),
  source_seq: 1,
  type,
  data,
});

test("诊断导出带按 Step 聚合的执行成本，压缩与工具次数来自诊断事件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-step-costs-"));
  const store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Step costs", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const plan = store.claim(id, "planner", 0)!;
    const snapshot = store.get(id);
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: plan.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: snapshot.planning_revision,
        steps: [
          { from: ["origin"], description: "Inspect the record endpoint", property: "只允许所有者读取记录" },
          { from: ["origin"], description: "Inspect the export endpoint" },
        ],
      }),
    );
    const job = store.claim(id, "executor", 0)!;
    assert.equal(job.kind, "execute");
    const executed = job.step_id!;
    // Two model requests, then two tool calls and one compaction in the same Run.
    store.usage(id, job, 5000, 800, null, "req-1");
    store.usage(id, job, 3000, 400, null, "req-2");
    // A third request starts but never reports usage: known tokens still add up,
    // while the Run must be counted as incomplete instead of looking complete.
    store.usage(id, job, null, null, null, "req-unknown", "started");
    const posted = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/jobs/diagnostics`,
      headers: { "x-tessera-worker-token": testWorkerToken },
      payload: {
        job,
        events: [
          event("tool_start", { tool: "read", tool_call_id: "t1", generation: 0 }),
          event("tool_start", { tool: "read", tool_call_id: "t2", generation: 0 }),
          event("compaction_start", { reason: "threshold", generation: 0, current: 30000, peak: 30000 }),
          event("compaction_end", { generation: 1, current: 15000, peak: 31000, source: "fixture" }),
        ],
      },
    });
    assert.equal(posted.statusCode, 200, posted.body);

    const response = await app.inject({ method: "GET", url: `/api/projects/${id}/diagnostics` });
    assert.equal(response.statusCode, 200, response.body);
    const lines = gunzipSync(response.rawPayload)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const costs = lines.find((line) => line.type === "step_costs");
    assert.ok(costs, "导出文件里必须有 Step 成本记录");
    assert.equal(costs.schema, "tessera.step-costs.v1");
    assert.equal(costs.steps, 2);
    assert.equal(costs.runs, 1);
    assert.equal(costs.compacted_steps, 1);
    assert.equal(costs.max_compactions, 1);
    assert.equal(costs.input_tokens, 8000);
    assert.equal(costs.output_tokens, 1200);
    assert.equal(costs.tool_calls, 2);
    assert.equal(costs.rows[0].step_id, executed);
    assert.equal(costs.rows[0].state, "running");
    assert.equal(costs.rows[0].attempts, 1);
    assert.equal(costs.rows[0].input_tokens, 8000);
    assert.equal(costs.rows[0].output_tokens, 1200);
    assert.equal(costs.rows[0].peak_context, 31000);
    assert.equal(costs.rows[0].compactions, 1);
    assert.equal(costs.rows[0].tool_calls, 2);
    assert.equal(costs.rows[0].unknown_usage_runs, 1, "a Run with an unfinished request is not complete usage");
    assert.equal(costs.rows[1].runs, 0, "没有 execute Run 的 Step 也保留一行");
    assert.equal(costs.rows[1].input_tokens, 0);
    assert.match(costs.note, /unknown_usage_runs/);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
