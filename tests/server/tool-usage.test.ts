import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { commitPlan } from "../helpers/current-api.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";

let sequence = 0;
const source = randomUUID();
const event = (type: string, data: Record<string, unknown>) => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  source_id: source,
  source_seq: ++sequence,
  type,
  data,
});

test("工具调用排行按工具与 Run 类型聚合，缺失 tool_end 只计次数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-tool-usage-"));
  const store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Tool usage", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const decide = store.claim(id, "planner", 0)!;
    const snapshot = store.get(id);
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: decide.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: snapshot.planning_revision,
        steps: [{ from: ["origin"], description: "Inspect the record endpoint" }],
      }),
    );
    const execute = store.claim(id, "executor", 0)!;
    assert.equal(execute.kind, "execute");

    const post = (job: typeof decide, events: unknown[]) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${id}/jobs/diagnostics`,
        headers: { "x-tessera-worker-token": testWorkerToken },
        payload: { job, events },
      });

    // 决策阶段：read_graph 两次（其中一次没有 tool_end），query_graph 一次失败。
    assert.equal(
      (
        await post(decide, [
          event("tool_start", { tool: "read_graph", tool_call_id: "d1", generation: 0 }),
          event("tool_end", {
            tool: "read_graph",
            tool_call_id: "d1",
            generation: 0,
            elapsed_ms: 40,
            is_error: false,
          }),
          event("tool_start", { tool: "read_graph", tool_call_id: "d2", generation: 0 }),
          event("tool_start", { tool: "query_graph", tool_call_id: "d3", generation: 0 }),
          event("tool_end", {
            tool: "query_graph",
            tool_call_id: "d3",
            generation: 0,
            elapsed_ms: 25,
            is_error: true,
          }),
        ])
      ).statusCode,
      200,
    );
    // 执行阶段：bash 一次、read 一次。
    assert.equal(
      (
        await post(execute, [
          event("tool_start", { tool: "bash", tool_call_id: "e1", generation: 0 }),
          event("tool_end", {
            tool: "bash",
            tool_call_id: "e1",
            generation: 0,
            elapsed_ms: 1500,
            is_error: false,
          }),
          event("tool_start", { tool: "read", tool_call_id: "e2", generation: 0 }),
          event("tool_end", { tool: "read", tool_call_id: "e2", generation: 0, elapsed_ms: 5, is_error: false }),
        ])
      ).statusCode,
      200,
    );

    const response = await app.inject({ method: "GET", url: `/api/projects/${id}/tool-usage` });
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.ok(body.through > 0);
    assert.deepEqual(
      body.tools.map((tool: { tool: string; calls: number }) => [tool.tool, tool.calls]),
      [
        ["read_graph", 2],
        ["bash", 1],
        ["query_graph", 1],
        ["read", 1],
      ],
    );
    assert.deepEqual(body.totals, {
      tools: 4,
      calls: 5,
      ended: 4,
      errors: 1,
      timed: 4,
      elapsed_ms: 1570,
    });

    const readGraph = body.tools[0];
    assert.equal(readGraph.by_kind.decide.calls, 2);
    assert.equal(readGraph.by_kind.decide.ended, 1);
    assert.equal(readGraph.by_kind.decide.timed, 1);
    assert.equal(readGraph.by_kind.decide.elapsed_ms, 40);
    assert.equal(readGraph.by_kind.execute, undefined);
    assert.ok(readGraph.last_at);
    const bash = body.tools[1];
    assert.equal(bash.by_kind.execute.calls, 1);
    assert.equal(bash.by_kind.execute.elapsed_ms, 1500);
    assert.equal(bash.by_kind.decide, undefined);
    const queryGraph = body.tools[2];
    assert.equal(queryGraph.by_kind.decide.errors, 1);
    assert.match(body.note, /tool_start/);

    // 没有诊断事件的项目保持空排行，而不是伪造 0 次工具。
    const emptyId = store.create(
      createProjectSchema.parse({ title: "Empty tools", origin: "https://empty.test", goal: "None" }),
    ).project.id;
    const empty = JSON.parse((await app.inject({ method: "GET", url: `/api/projects/${emptyId}/tool-usage` })).body);
    assert.deepEqual(empty.tools, []);
    assert.deepEqual(empty.totals, { tools: 0, calls: 0, ended: 0, errors: 0, timed: 0, elapsed_ms: 0 });
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("归档后的诊断仍计入工具排行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-tool-usage-archive-"));
  const store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Archived tools", origin: "https://archive.test", goal: "Assess" }),
    ).project.id;
    const job = store.claim(id, "planner", 0)!;
    const posted = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/jobs/diagnostics`,
      headers: { "x-tessera-worker-token": testWorkerToken },
      payload: {
        job,
        events: [
          event("tool_start", { tool: "read_graph", tool_call_id: "a1", generation: 0 }),
          event("tool_end", {
            tool: "read_graph",
            tool_call_id: "a1",
            generation: 0,
            elapsed_ms: 30,
            is_error: false,
          }),
          event("tool_start", { tool: "read", tool_call_id: "a2", generation: 0 }),
        ],
      },
    });
    assert.equal(posted.statusCode, 200, posted.body);

    const run = store.execution.get(id, job.run_id!)!;
    run.status = "succeeded";
    run.finished_at = new Date().toISOString();
    store.execution.save(run);
    const archived = store.retention.archive(
      { events_days: 0, diagnostics_days: 1, evidence_days: 0, batch: 100 },
      Date.now() + 2 * 86_400_000,
    );
    assert.equal(archived.diagnostics, 3);
    assert.equal(
      Number(store.db.prepare("SELECT COUNT(*) AS n FROM platform_diagnostics WHERE project_id=?").get(id)?.n),
      0,
    );

    const response = await app.inject({ method: "GET", url: `/api/projects/${id}/tool-usage` });
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.deepEqual(
      body.tools.map((tool: { tool: string; calls: number }) => [tool.tool, tool.calls]),
      [
        ["read", 1],
        ["read_graph", 1],
      ],
    );
    assert.equal(body.totals.calls, 2);
    assert.equal(body.totals.ended, 1);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
