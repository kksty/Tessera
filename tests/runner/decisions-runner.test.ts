import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { reportFields } from "../fixtures/report.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";

function sse(reply: any, delta: unknown, finish: string) {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream" });
  reply.raw.end(
    `data: ${JSON.stringify({
      id: "decisions",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", ...(delta as object) }, finish_reason: null }],
    })}\n\n` +
      `data: ${JSON.stringify({
        id: "decisions",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      })}\n\ndata: [DONE]\n\n`,
  );
}
const call = (name: string, args: unknown, index = 0) => ({
  tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

for (const finalRetry of [false, true])
  test(`Decide reconsiders a settle conflict through ${finalRetry ? "final JSON" : "the tool"} without replaying the plan`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-decisions-runner-"));
    const store = new Store(join(dir, "graph.db"));
    const id = store.create(
      createProjectSchema.parse({ title: "Decisions runner", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    // An existing, executed-but-open Step with a newer version than the model saw.
    const planner = store.claim(id, "planner", 0)!;
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: planner.worker,
        revision: store.get(id).revision,
        observation_revision: store.get(id).observation_revision,
        steps: [{ from: ["origin"], description: "Existing question" }],
      }),
    );
    const stepId = store.get(id).steps[0].id;
    const executor = store.claim(id, "executor", 0)!;
    store.execute(
      id,
      stepId,
      executeSchema.parse({ worker: executor.worker, facts: ["Partial result"], summary: "partial" }),
    );
    const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const model = Fastify();
    const calls: { tools: string[]; messages: string }[] = [];
    model.post("/v1/chat/completions", async (req, reply) => {
      const body = req.body as { tools: { function: { name: string } }[]; messages: unknown[] };
      calls.push({ tools: body.tools.map((t) => t.function.name), messages: JSON.stringify(body.messages) });
      if (calls.length === 1) {
        return sse(
          reply,
          call("submit_decisions", {
            steps: [{ from: ["origin"], description: "Plan from the tool" }],
            closes: [{ id: stepId, reason: "First attempt", evidence_ids: [], expected_version: 1 }],
          }),
          "tool_calls",
        );
      }
      if (calls.length === 2) {
        // The model only sees the conflict and retries settlement fields; the runtime reuses plan_id.
        assert.match(calls[1].messages, /version changed/);
        assert.match(calls[1].messages, /current_view/);
        assert.equal(
          store.get(id).steps.find((s) => s.id === stepId)!.concluded_at,
          null,
          "the runtime cannot apply an old decision with a newer version",
        );
        const settled = {
          closes: [{ id: stepId, reason: "Evidence is enough", evidence_ids: [], expected_version: 2 }],
        };
        return sse(
          reply,
          finalRetry ? { content: JSON.stringify(settled) } : call("submit_decisions", settled),
          finalRetry ? "stop" : "tool_calls",
        );
      }
      // After a complete settle the runtime blocks further tools; the turn ends without final JSON.
      return sse(reply, { content: "已提交。" }, "stop");
    });
    await model.listen({ host: "127.0.0.1", port: 0 });
    const config = {
      ...new RuntimeConfig(join(dir, "runtime.json")).value,
      server: app.listeningOrigin,
      model: {
        id: "fixture",
        base_url: model.listeningOrigin + "/v1",
        api_key: "test",
        api: "openai-completions",
        context_window: 128000,
      },
    };
    try {
      const job = store.claim(id, "decide-planner", 0)!;
      assert.equal(job.kind, "decide");
      await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
      const graph = store.get(id);
      assert.ok(calls[0].tools.includes("submit_decisions"), "the only Decide write tool is advertised");
      assert.ok(!calls[0].tools.includes("submit_fact"), "Decide cannot write observations");
      assert.equal(graph.project.reason, null);
      assert.equal(graph.project.decision_round, 2, "the settled retry advances the decision clock");
      assert.equal(graph.steps.length, 2, "the plan is never replayed on settle retry");
      assert.ok(graph.steps.some((s) => s.description === "Plan from the tool"));
      const closed = graph.steps.find((s) => s.id === stepId)!;
      assert.ok(closed.concluded_at);
      assert.equal(
        closed.close_reason,
        "Evidence is enough",
        "only the model's explicit reconsidered decision can close the Step",
      );
      assert.ok(closed.executed_at);
      // The run ends as successful without a final Decide JSON submission.
      const run = store.runs(id)[0];
      assert.equal(run.status, "succeeded");
      // After a committed settlement the turn ends without another provider
      // request; the server lease is already released, so that request would 409.
      assert.equal(calls.length, 2, "no provider request follows a committed settlement");
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans WHERE project_id=?").get(id)!.n, 2);
    } finally {
      await model.close();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const path of ["final", "tool", "read"] as const)
  test(`completion acknowledges new observations only after the model sees them (${path})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-decide-snapshot-"));
    const store = new Store(join(dir, "graph.db"));
    const id = store.create(
      createProjectSchema.parse({ title: "Snapshot", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const runtime = new RuntimeConfig(join(dir, "config.json"));
    const app = buildApp(store, runtime, join(dir, "no-web"));
    const model = Fastify();
    let requests = 0;
    const completion = { complete: { from: ["origin"], description: "Finish after considering all observations" } };
    model.post("/v1/chat/completions", async (req, reply) => {
      requests++;
      const messages = JSON.stringify((req.body as { messages: unknown[] }).messages);
      if (requests === 1) {
        assert.doesNotMatch(messages, /newly-discovered/);
        store.discover(id, [
          { hostname: "newly-discovered.example.test", source: "Parallel observation", evidence_ids: [] },
        ]);
        if (path === "read") return sse(reply, call("read_graph", {}), "tool_calls");
        return sse(
          reply,
          path === "tool" ? call("submit_decisions", completion) : { content: JSON.stringify(completion) },
          path === "tool" ? "tool_calls" : "stop",
        );
      }
      assert.match(messages, /newly-discovered/);
      assert.equal(store.get(id).project.status, "active", "unseen observations cannot be acknowledged automatically");
      if (path === "tool") assert.match(messages, /Graph changed/);
      return sse(reply, { content: JSON.stringify(completion) }, "stop");
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      await model.listen({ host: "127.0.0.1", port: 0 });
      const job = store.claim(id, "planner", 0)!;
      const config = {
        ...runtime.value,
        server: app.listeningOrigin,
        model: {
          id: "fixture",
          base_url: model.listeningOrigin + "/v1",
          api_key: "test",
          api: "openai-completions",
          context_window: 128000,
        },
      };
      await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
      const graph = store.get(id);
      if (path === "final") {
        assert.equal(graph.project.status, "active");
        assert.equal(graph.decided_revision, 0);
        assert.equal(graph.project.decide_conflicts, 1);
        assert.equal(requests, 1);
      } else {
        assert.equal(graph.project.status, "completed");
        assert.equal(graph.decided_revision, graph.observation_revision);
        assert.equal(requests, 2);
      }
    } finally {
      await model.close();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const useTool of [false, true])
  test(`a concurrent Hint rewrite is a refresh conflict without model backoff (${useTool ? "tool" : "final"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-decide-hint-"));
    const store = new Store(join(dir, "graph.db"));
    const id = store.create(
      createProjectSchema.parse({
        title: "Human intent",
        origin: "https://example.test",
        goal: "Assess",
        hints: [{ content: "Original instruction" }],
      }),
    ).project.id;
    const runtime = new RuntimeConfig(join(dir, "config.json"));
    const app = buildApp(store, runtime, join(dir, "no-web"));
    const model = Fastify();
    let requests = 0;
    model.post("/v1/chat/completions", async (req, reply) => {
      requests++;
      if (requests === 1) store.updateHint(id, "h001", { content: "Rewritten instruction" });
      if (requests === 2) {
        const messages = JSON.stringify((req.body as { messages: unknown[] }).messages);
        assert.match(messages, /current_view/);
        assert.match(messages, /Rewritten instruction/);
        assert.equal(store.get(id).hints[0].resolved, undefined);
      }
      const payload = {
        hint_notes: [
          {
            id: "h001",
            note: requests === 1 ? "Answer to the old instruction" : "Answer to the rewritten instruction",
          },
        ],
        complete: { from: ["origin"], description: "Done" },
      };
      return sse(
        reply,
        useTool && requests === 1 ? call("submit_decisions", payload) : { content: JSON.stringify(payload) },
        useTool && requests === 1 ? "tool_calls" : "stop",
      );
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      await model.listen({ host: "127.0.0.1", port: 0 });
      const job = store.claim(id, "planner", 0)!;
      const config = {
        ...runtime.value,
        server: app.listeningOrigin,
        model: {
          id: "fixture",
          base_url: model.listeningOrigin + "/v1",
          api_key: "test",
          api: "openai-completions",
          context_window: 128000,
        },
      };
      await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
      let graph = store.get(id);
      assert.equal(graph.project.last_error, undefined);
      assert.equal(graph.project.decide_retry_at, undefined);
      if (useTool) {
        // The tool retry sees the rewritten Hint but a model note cannot close it.
        assert.equal(requests, 2);
        assert.equal(graph.project.status, "active");
        assert.equal(graph.hints[0].resolved, undefined);
        // The operator confirms the directive before the next Decide round.
        store.resolveHint(id, "h001", { note: "Operator confirmed the rewritten instruction" });
        const next = store.claim(id, "next-planner", 0)!;
        assert.equal(next.kind, "decide");
        await runJob(next, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
        graph = store.get(id);
        assert.equal(requests, 3);
        assert.equal(graph.project.status, "completed");
        assert.equal(graph.hints[0].resolved?.note, "Operator confirmed the rewritten instruction");
      } else {
        assert.equal(requests, 1);
        assert.equal(graph.project.status, "active");
        assert.equal(graph.project.decide_conflicts, 1);
        assert.equal(graph.hints[0].resolved, undefined);
        assert.equal(store.claim(id, "next-planner", 0)!.kind, "decide");
      }
    } finally {
      await model.close();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("an oversized settlement is applied in ordered parts under one Decide run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-decide-batch-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Batched settle", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const findings = Array.from({ length: 30 }, (_, index) =>
    store.submitFinding(
      id,
      findingSchema.parse({
        ...reportFields,
        title: `Finding ${index + 1}`,
        description: `Original description ${index + 1}`,
        identity: {
          category: "access_control",
          host: "example.test",
          path: `/records/${index + 1}`,
          parameter: "id",
        },
        from: ["origin"],
      }),
    ),
  );
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  let rejected = 0;
  app.addHook("onResponse", async (_req, reply) => {
    if (reply.statusCode === 409) rejected++;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const model = Fastify();
  let requests = 0;
  model.post("/v1/chat/completions", async (_req, reply) => {
    requests++;
    const payload = {
      finding_updates: findings.map((finding, index) => ({
        id: finding.id,
        expected_version: 1,
        reason: "Clarify the report",
        changes: { description: `Revised description ${index + 1}\n${"独立复核证据与影响说明。".repeat(50)}` },
      })),
    };
    if (requests === 1) return sse(reply, call("submit_decisions", payload), "tool_calls");
    throw new Error("no provider request may follow the final settlement part");
  });
  try {
    await model.listen({ host: "127.0.0.1", port: 0 });
    const runtime = new RuntimeConfig(join(dir, "runtime.json"));
    const job = store.claim(id, "planner", 0)!;
    const config = {
      ...runtime.value,
      server: app.listeningOrigin,
      model: {
        id: "fixture",
        base_url: model.listeningOrigin + "/v1",
        api_key: "test",
        api: "openai-completions",
        context_window: 128000,
      },
    };
    await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
    const graph = store.get(id);
    assert.equal(requests, 1, "the runner batches one model response without another provider request");
    assert.equal(graph.project.reason, null, "only the final part releases the Decide lease");
    assert.equal(graph.project.decision_round, 1, "one logical settlement advances the round once");
    assert.ok(
      graph.findings.every((finding) => finding.version === 2 && finding.description.startsWith("Revised description")),
      "every Finding revision was applied exactly once",
    );
    const parts = store.db.prepare("SELECT COUNT(*) AS n FROM platform_submissions WHERE project_id=?").get(id)!
      .n as number;
    assert.ok(parts >= 2, `the oversized payload was split into ${parts} server submissions`);
    assert.equal(rejected, 0, "no part was rejected after the lease ended (the old post-settlement 409)");
    assert.equal(store.runs(id)[0].status, "succeeded");
  } finally {
    await model.close();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
