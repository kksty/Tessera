import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  findingSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { parseModelJson, resultRepairPrompt } from "../../packages/runner/src/prompts.js";
import { recoverReadOnly } from "../../packages/runner/src/read-only-recovery.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { modelCatalog, modelMetadata } from "../../packages/models/src/runtime.js";
import { fallbackEnvironment, taskResources, taskSystemPrompts } from "../../packages/runner/src/task-resources.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

const autoResourceMarker = "TESSERA_AUTOMATIC_RESOURCE_MUST_NOT_LOAD";
function plantAutomaticResources(workspace: string, directory: string) {
  for (const base of [workspace, join(workspace, ".pi"), directory]) {
    mkdirSync(base, { recursive: true });
    for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md"])
      writeFileSync(join(base, name), autoResourceMarker);
    for (const name of ["skills/injected", "prompts", "extensions", "themes"])
      mkdirSync(join(base, name), { recursive: true });
    writeFileSync(
      join(base, "skills/injected/SKILL.md"),
      `---\nname: injected\ndescription: ${autoResourceMarker}\n---\n${autoResourceMarker}`,
    );
    writeFileSync(join(base, "prompts/injected.md"), autoResourceMarker);
    writeFileSync(join(base, "extensions/injected.ts"), `throw new Error('${autoResourceMarker}');`);
    writeFileSync(join(base, "themes/injected.json"), JSON.stringify({ name: autoResourceMarker }));
  }
}
function assertTaskRequest(body: any, expectedTools: string[]) {
  const system = body.messages
    .filter((m: any) => m.role === "system")
    .map((m: any) => m.content)
    .join("\n");
  assert.ok(system.includes(taskSystemPrompts(fallbackEnvironment).systemPrompt));
  // Pi resources are disabled, so a planted workspace resource must not add a
  // description or execute. The coding-agent system prompt is replaced too.
  assert.doesNotMatch(system, /expert coding assistant|Pi documentation|TESSERA_AUTOMATIC_RESOURCE_MUST_NOT_LOAD/);
  // Resource loading is an implementation detail; the model context must not
  // announce which Pi resource types are enabled or disabled.
  assert.doesNotMatch(system, /skills?|extensions?|prompt templates?|themes?/i);
  const names = body.tools.map((t: any) => t.function.name).sort();
  assert.deepEqual(names, [...expectedTools].sort());
}

test("task resources use explicit prompts, load no Pi resources and keep ordinary SDK compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-resources-"));
  try {
    plantAutomaticResources(dir, join(dir, "agent"));
    const settings = SettingsManager.inMemory();
    for (const path of [join(dir, "absent.md"), join(dir, "blank.md")]) {
      if (path.endsWith("blank.md")) writeFileSync(path, "  \n");
      const { loader, environment } = await taskResources(dir, join(dir, "agent"), settings, path);
      assert.equal(environment, fallbackEnvironment);
      // The workspace cannot inject any Pi resource into the task.
      assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
      assert.deepEqual(loader.getSkills().skills, []);
      assert.deepEqual(loader.getExtensions().extensions, []);
      assert.deepEqual(loader.getPrompts().prompts, []);
      assert.deepEqual(loader.getThemes().themes, []);
      assert.equal(settings.getCompactionSettings().enabled, true);
    }
    const path = join(dir, "environment.md");
    writeFileSync(path, "Controlled environment");
    assert.equal((await taskResources(dir, join(dir, "agent"), settings, path)).environment, "Controlled environment");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("final JSON ignores complete leading thinking blocks but never accepts truncated envelopes", () => {
  assert.deepEqual(parseModelJson('<think>Example: {"wrong":true}</think>\n```json\n{"summary":"完成"}\n```'), {
    summary: "完成",
  });
  for (const raw of [
    '<think>{"summary":"thinking only"}',
    '<think>done</think>\n.json\n{"steps":[]}\n```',
    '<think>done</think>\n"steps": [{"from":["origin"]}]}',
  ])
    assert.throws(() => parseModelJson(raw));
});

test("final JSON accepts one terminal fenced envelope after explanatory prose", () => {
  // GLM-5 repair answers explain the decision and then fence the JSON instead of
  // returning it as the whole body; the fence is unambiguous, so it is the answer.
  assert.deepEqual(
    parseModelJson(
      [
        "所有提交类型在 closeout 模式下均被拒绝。已读取全部已有记录：",
        "- 三个 blocked Step 按规则交人工检查，不换名或拆分重试。",
        "- 无 Finding、无 Review。",
        "",
        "```json",
        '{"delete_nodes":[],"steps":[],"closes":[],"lead_dispositions":[]}',
        "```",
      ].join("\n"),
    ),
    { delete_nodes: [], steps: [], closes: [], lead_dispositions: [] },
  );
  assert.deepEqual(parseModelJson('说明：无可提交动作。\n\n```\n{"steps":[]}\n```\n'), { steps: [] });
});

test("final JSON skips a warning glyph before a complete leading thinking block", () => {
  assert.deepEqual(
    parseModelJson(
      '⚠<think>\nBlocked steps need human inspection.\n</think>\n说明如下。\n\n```json\n{"steps":[]}\n```',
    ),
    { steps: [] },
  );
  // An unclosed or decorative block still hides no result: reject instead of salvaging.
  for (const raw of [
    "⚠<think>\nstill thinking",
    '⚠<think>{"bad":true}</think>\n没有最终答案',
    '说明：\n```text\n{"steps":[]}\n```',
    '说明：\n```json\n{"steps":[]',
  ])
    assert.throws(() => parseModelJson(raw));
});

test("captured GLM final and repair envelopes remain rejected without guessing or salvaging", () => {
  const fixture = JSON.parse(readFileSync(resolve("tests/fixtures/glm-damaged-envelopes.json"), "utf8"));
  assert.equal(fixture.samples.length, 2);
  for (const sample of fixture.samples) {
    assert.ok(!sample.public_body_after_thinking.includes("<think>"));
    assert.throws(() => parseModelJson(sample.public_body_after_thinking), /no valid JSON result/);
  }
});

test("repair contracts describe the correct job without requiring runtime identity fields", () => {
  for (const kind of ["decide", "execute", "review"] as const) {
    const prompt = resultRepairPrompt({ kind } as any, "specific error");
    assert.match(prompt, /specific error/);
    assert.match(prompt, /错误说明都不是任务结果/);
    const schema = JSON.parse(prompt.split("\n").find((line) => line.startsWith("{"))!);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.worker, undefined);
    assert.ok(schema.properties[kind === "decide" ? "steps" : kind === "execute" ? "summary" : "verdict"]);
    if (kind === "execute") assert.equal(schema.properties.read_only, undefined);
  }
});

test("a Hint that arrives during planning is never completed away silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-conflict-"));
  const store = new Store(join(dir, "graph.db"));
  const graph = store.create(
    createProjectSchema.parse({ title: "Concurrent", origin: "https://example.test", goal: "Assess" }),
  );
  const runtime = new RuntimeConfig(join(dir, "config.json"));
  const app = buildApp(store, runtime, join(dir, "no-web"));
  const model = Fastify();
  let calls = 0;
  model.post("/v1/chat/completions", async (_req, reply) => {
    calls++;
    // The first Decide never sees this Hint: it is written while the model is
    // thinking. The second Decide receives it and must answer it explicitly.
    if (calls === 1) store.hint(graph.project.id, "New observation during planning");
    const payload =
      calls === 1
        ? { complete: { from: ["origin"], description: "Assessment completed" } }
        : {
            hint_notes: [{ id: "h001", note: "已纳入本轮结论，无需单独立项" }],
            complete: { from: ["origin"], description: "Assessment completed" },
          };
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.end(
      `data: ${JSON.stringify({ id: "conflict", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "conflict", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await model.listen({ host: "127.0.0.1", port: 0 });
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
  try {
    const job = store.claim(graph.project.id, "first-planner", 0)!;
    await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
    const refused = store.get(graph.project.id);
    // Completion is valid only for the Hint set the Decider actually read: the
    // new Hint is unanswered, so the project stays active for another round.
    assert.equal(refused.project.status, "active");
    assert.equal(refused.project.pending_completion, undefined);
    assert.equal(refused.hints[0].resolved, undefined, "an unanswered Hint must not be swallowed");
    assert.equal(refused.project.last_error, undefined);
    assert.equal(refused.project.decide_conflicts, 1);
    assert.equal(calls, 1);

    // The operator confirms the directive; the next Decide can then complete.
    store.resolveHint(graph.project.id, "h001", { note: "Operator confirmed the new directive" });
    const next = store.claim(graph.project.id, "second-planner", 0)!;
    assert.equal(next.kind, "decide");
    await runJob(next, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
    const current = store.get(graph.project.id);
    assert.equal(current.project.status, "completed");
    assert.equal(current.steps.length, 1, "completion archives exactly one Step");
    assert.equal(current.steps[0].to, "goal");
    assert.equal(current.hints[0].resolved?.note, "Operator confirmed the new directive");
    assert.equal(calls, 2);
  } finally {
    await model.close();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi SDK calls an actual tool and commits observations through the HTTP API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-sdk-")),
    store = new Store(join(dir, "graph.db"));
  const graph = store.create(
    createProjectSchema.parse({
      title: "SDK fixture",
      origin: "https://example.test",
      goal: "Exercise tool feedback",
    }),
  );
  const d = store.claim(graph.project.id, "planner", 0)!;
  commitPlan(
    store,
    graph.project.id,
    decideSchema.parse({
      worker: d.worker,
      revision: 1,
      observation_revision: 1,
      steps: [{ from: ["origin"], description: "Record an observation" }],
    }),
  );
  const job = store.claim(graph.project.id, "sdk-worker", 0)!;
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const model = Fastify();
  let calls = 0;
  model.post("/v1/chat/completions", async (req, reply) => {
    calls++;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null = null) =>
      reply.raw.write(
        `data: ${JSON.stringify({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    send({ reasoning_content: "private-thought-never-capture" });
    if (calls === 1) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: {
              name: "submit_fact",
              arguments: JSON.stringify({
                description: "Verified tool observation",
                conclusion: "The tool observation is verified",
                evidence_ids: [],
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else if (calls === 2) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_finding",
            type: "function",
            function: {
              name: "submit_finding",
              arguments: JSON.stringify({
                title: "Streamed issue",
                description: "Check original evidence",
                evidence: "Tool observation",
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      assert.ok(JSON.stringify(req.body).includes("Verified tool observation"));
      send({
        role: "assistant",
        content: JSON.stringify({
          facts: ["Second observation"],
          summary: "Original tool result persisted",
        }),
      });
      send({}, "stop");
    }
    reply.raw.write(
      `data: ${JSON.stringify({
        id: "test-completion",
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          ...(calls === 1
            ? { prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } }
            : calls === 2
              ? { prompt_cache_hit_tokens: 0 }
              : {}),
        },
      })}\n\ndata: [DONE]\n\n`,
    );
    reply.raw.end();
  });
  await model.listen({ host: "127.0.0.1", port: 0 });
  const config = {
    ...new RuntimeConfig(join(dir, "runtime.json")).value,
    server: app.listeningOrigin,
    model: {
      id: "fixture",
      base_url: model.listeningOrigin + "/v1",
      api_key: "fixture-key",
      api: "openai-completions",
      context_window: 128000,
    },
  };
  try {
    await runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
    const result = store.get(graph.project.id);
    assert.equal(calls, 3);
    assert.equal(result.steps[0].fact_ids.length, 2);
    assert.equal(result.steps[0].summary, "Original tool result persisted");
    assert.ok(result.usage[0].input !== null);
    assert.equal(result.usage[0].cost, null);
    assert.equal(result.usage[0].input, 100);
    assert.equal(result.usage[0].input_uncached, 50);
    assert.equal(result.usage[0].cache_read, 40);
    assert.equal(result.usage[0].cache_write, 10);
    assert.equal(result.usage[1].cache_read, 0);
    assert.equal(result.usage[1].cache_write, null);
    assert.equal(result.usage[2].cache_read, null);
    const capturedText = readFileSync(join(dir, "runs", job.worker, "model-responses.ndjson"), "utf8");
    assert.ok(!capturedText.includes("private-thought-never-capture"));
    const captured = capturedText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(captured.filter((e) => e.type === "request_start").length, 3);
    assert.equal(captured.filter((e) => e.type === "sdk_message").length, 3);
    const parseInput = captured.find((e) => e.type === "parse_input");
    const sdkMessage = captured.find((e) => e.request_id === parseInput.request_id && e.type === "sdk_message");
    assert.equal(
      parseInput.data.text,
      sdkMessage.data.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n"),
    );
    assert.equal(result.findings[0].step_id, job.step_id);
    assert.equal(result.findings[0].graph_id, "main");
    const diagnostics = readFileSync(join(dir, "runs", job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const starts = diagnostics.filter((e) => e.type === "tool_start");
    const ends = diagnostics.filter((e) => e.type === "tool_end");
    assert.ok(starts.length > 0);
    for (const start of starts) {
      const end = ends.find((e) => e.data.tool_call_id === start.data.tool_call_id);
      assert.ok(end, "tool diagnostics must correlate by tool_call_id");
      assert.ok(end.data.elapsed_ms >= 0);
      assert.ok(end.data.result_chars > 0);
    }
    assert.equal(diagnostics.filter((e) => e.type === "model_end").length, 3);
    assert.ok(diagnostics.some((e) => e.type === "model_end" && typeof e.data.cache_read === "number"));
    assert.equal(diagnostics.at(-1).type, "run_end");
    // The Run summary carries the cost fields the export relies on: a long Run
    // must be explainable from its own end event, not only from edited code paths.
    const end = diagnostics.at(-1)!.data;
    assert.equal(end.step_attempts, 1);
    assert.equal(end.tool_calls, 2);
    assert.equal(end.closeout, false);
    assert.equal(end.compactions, 0);
    assert.equal(typeof end.threshold, "number");
    assert.equal(typeof end.window, "number");
    assert.ok(end.duration_ms >= 0);
  } finally {
    await model.close();
    await app.close();
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model selection discovers API metadata and supplies automatic context without returning the stored key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-models-")),
    store = new Store(join(dir, "graph.db")),
    runtime = new RuntimeConfig(join(dir, "runtime.json")),
    provider = Fastify();
  provider.get("/v1/models", (req) => {
    assert.equal(req.headers.authorization, "Bearer stored-test-key");
    return {
      data: [
        { id: "model-fixture", name: "Fixture Model", max_model_len: 32000 },
        { id: "unknown-fixture" },
        // A catalog model served by a custom gateway may have a smaller window
        // than the public deployment with the same id; do not borrow its name.
        { id: "glm-5" },
      ],
    };
  });
  provider.get("/other/v1/models", (req) => {
    assert.equal(req.headers.authorization, undefined, "Changing endpoints must not reuse the old provider credential");
    return { data: [{ id: "local-fixture", max_model_len: 262144 }] };
  });
  await provider.listen({ host: "127.0.0.1", port: 0 });
  runtime.update({
    ...runtime.value,
    model: {
      ...runtime.value.model,
      base_url: provider.listeningOrigin + "/v1/chat/completions",
      api_key: "stored-test-key",
    },
  });
  const app = buildApp(store, runtime, join(dir, "no-web"));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/models",
      payload: {
        base_url: provider.listeningOrigin + "/v1",
        api: "openai-completions",
        api_key: "",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].context_window, 32000);
    assert.equal(response.json()[0].context_source, "api");
    assert.equal(response.json()[1].context_window, 128000);
    assert.equal(response.json()[2].context_window, 128000);
    assert.equal(response.json()[2].context_source, "default");
    assert.ok(!response.body.includes("stored-test-key"));
    const changed = await app.inject({
      method: "POST",
      url: "/api/runtime/models",
      payload: {
        base_url: provider.listeningOrigin + "/other/v1/chat/completions",
        api: "openai-completions",
        api_key: "",
      },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json()[0].context_window, 262144);
    runtime.update({
      ...runtime.value,
      model: { ...runtime.value.model, base_url: provider.listeningOrigin + "/other/v1/chat/completions", api_key: "" },
    });
    assert.equal(runtime.value.model.api_key, "");
    assert.equal(runtime.value.model.base_url, provider.listeningOrigin + "/other/v1");
  } finally {
    await provider.close();
    await app.close();
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function sdkFixture(kind: "execute" | "decide" | "review" = "execute") {
  const dir = mkdtempSync(join(tmpdir(), "tessera-closeout-")),
    store = new Store(join(dir, "graph.db"));
  const graph = store.create(
    createProjectSchema.parse({ title: "Closeout", origin: "https://example.test", goal: "Save results" }),
  );
  const planner = store.claim(graph.project.id, "planner", 0)!,
    snapshot = store.get(graph.project.id);
  if (kind === "execute")
    commitPlan(
      store,
      graph.project.id,
      decideSchema.parse({
        worker: planner.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision,
        planning_revision: snapshot.planning_revision,
        steps: [{ from: ["origin"], description: "Observe" }],
      }),
    );
  if (kind === "review")
    store.submitFinding(
      graph.project.id,
      findingSchema.parse({ title: "Review fixture", description: "Existing claim", from: ["origin"] }),
    );
  const job = kind === "decide" ? planner : store.claim(graph.project.id, "executor", 0)!;
  plantAutomaticResources(dir, join(dir, "runs", job.worker));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web")),
    model = Fastify();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const config = {
    ...new RuntimeConfig(join(dir, "config.json")).value,
    server: app.listeningOrigin,
    model: {
      id: "fixture",
      base_url: "http://fixture.invalid/v1",
      api_key: "fixture-key",
      api: "openai-completions",
      context_window: 32000,
    },
  };
  return {
    dir,
    store,
    graph,
    job,
    app,
    model,
    config,
    run: async () => {
      await model.listen({ host: "127.0.0.1", port: 0 });
      config.model.base_url = model.listeningOrigin + "/v1";
      return runJob(job, config, new ApiClient(app.listeningOrigin, testWorkerToken), dir);
    },
    close: async () => {
      await model.close();
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function streamFixture(reply: any, delta: unknown, input = 1000) {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "closeout", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  reply.raw.end(
    chunk(delta) +
      chunk({}, (delta as any).tool_calls ? "tool_calls" : "stop") +
      `data: ${JSON.stringify({ id: "closeout", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: input, completion_tokens: 30, total_tokens: input + 30 } })}\n\ndata: [DONE]\n\n`,
  );
}
const toolCall = (name: string, args: unknown, index = 0) => ({
  index,
  id: `call_${name}_${index}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("a missing CVSS AT metric is repaired in the same Review run before API submission", async () => {
  const f = await sdkFixture("review");
  let calls = 0;
  const proof = f.store.addEvidence(f.graph.project.id, {
    title: "Proof",
    content: "Existing proof",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.store.mutate(f.graph.project.id, "fixture.report", false, (g) =>
    Object.assign(g.findings[0], reportFields, { evidence_ids: [proof.id] }),
  );
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    calls++;
    if (calls === 2) assert.match(JSON.stringify(req.body.messages), /Missing CVSS Base metric AT/);
    const rating = { ...cvss.high, vector: calls === 1 ? cvss.high.vector.replace("/AT:N", "") : cvss.high.vector };
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({
        kind: "vulnerability",
        verdict: "pass",
        reason: "Impact verified from existing evidence",
        evidence_ids: [proof.id],
        cvss: rating,
      }),
    });
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    const graph = f.store.get(f.graph.project.id);
    assert.equal(graph.reviews.length, 1);
    assert.equal(graph.findings[0].cvss?.vector, cvss.high.vector);
    assert.equal(f.store.runs(f.graph.project.id).filter((r) => r.kind === "review").length, 1);
  } finally {
    await f.close();
  }
});

test("a finding identity that cannot pass the API is rejected with its field before upload", async () => {
  const f = await sdkFixture("execute");
  let calls = 0;
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    calls++;
    if (calls === 1)
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [
          toolCall("submit_finding", {
            title: "Missing entry",
            description: "The identity has a host but no path",
            identity: { category: "access_control", host: "example.test" },
          }),
        ],
      });
    assert.match(
      JSON.stringify(req.body.messages),
      /Invalid finding submission: identity: Identity requires a path or location/,
    );
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({ facts: [], findings: [], summary: "Invalid identity rejected locally" }),
    });
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    assert.equal(f.store.get(f.graph.project.id).findings.length, 0);
  } finally {
    await f.close();
  }
});

test("Pi Review preserves useful information with explicit classification and no vulnerability score", async () => {
  const f = await sdkFixture("review");
  const proof = f.store.addEvidence(f.graph.project.id, {
    title: "Information proof",
    content: "Original observation",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.store.mutate(f.graph.project.id, "fixture.review-evidence", true, (graph) => {
    graph.findings[0].evidence_ids = [proof.id];
  });
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    const input = JSON.stringify(req.body.messages);
    assert.match(input, /kind/);
    assert.doesNotMatch(input, /不把它当成另一个 informational Finding 重建/);
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({
        kind: "informational",
        verdict: "pass",
        reason: "有独立价值的信息结论已由原始材料支持",
        severity: null,
        evidence_ids: [proof.id],
      }),
    });
  });
  try {
    await f.run();
    const graph = f.store.get(f.graph.project.id),
      finding = graph.findings[0];
    assert.equal(finding.kind, "informational");
    assert.equal(finding.review_status, "pass");
    assert.equal(finding.severity, null);
    assert.equal(finding.cvss, null);
    assert.equal(graph.reviews[0].kind, "informational");
    assert.equal(f.store.overview().totals.confirmed, 0);
    assert.equal(f.store.overview().totals.informational, 1);
  } finally {
    await f.close();
  }
});

test("Pi follows a causal premise without keyword search and reads original conditions and counterevidence", async () => {
  const f = await sdkFixture();
  let calls = 0;
  const id = f.graph.project.id;
  const proof = f.store.addEvidence(id, {
    title: "Original conditional evidence",
    content: "当前授权只允许已批准主机；不同会话下结果相反",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.store.mutate(id, "fixture.premises", true, (graph) => {
    const current = graph.steps[0];
    graph.facts.push(
      {
        id: "f-premise",
        description: "必要条件".repeat(80) + "尾部限制：不能把旧会话成功归到当前会话",
        conclusion: "结果依赖会话",
        evidence_ids: [proof.id],
        graph_id: "main",
        step_id: "s-prior",
      },
      {
        id: "f-counter",
        description: "当前会话观测与原有前提矛盾",
        conclusion: "前提有争议",
        status: "disputed",
        evidence_ids: [proof.id],
        graph_id: "main",
      },
      {
        id: "f-middle",
        description: "中间结论需要核对上游条件",
        conclusion: "核对因果条件",
        evidence_ids: [],
        graph_id: "main",
        step_id: "s-middle",
      },
    );
    for (const step of [
      { id: "s-prior", from: ["origin"], fact_ids: ["f-premise"] },
      { id: "s-middle", from: ["f-premise", "f-counter"], fact_ids: ["f-middle"] },
    ])
      graph.steps.push({
        ...current,
        ...step,
        worker: null,
        run_id: undefined,
        concluded_at: "done",
        executed_at: "done",
        summary: "已归档",
      });
    current.from = ["f-middle"];
    current.reopen_reason = "前提和会话状态已变化";
    graph.project.hot_limit = 1;
  });
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    const messages = req.body.messages,
      tool = messages.filter((m: any) => m.role === "tool").at(-1);
    calls++;
    if (calls === 1)
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("query_graph", { related_to: "f-middle", relation: "sources", depth: 3 })],
      });
    if (calls === 2) {
      const result = JSON.parse(tool.content);
      assert.ok(result.items.some((item: any) => item.id === "f-premise"));
      assert.ok(result.items.some((item: any) => item.id === "f-counter"));
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", { id: "f-premise" })] });
    }
    if (calls === 3) {
      assert.match(JSON.parse(tool.content).content, /尾部限制：不能把旧会话成功归到当前会话/);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_evidence", { id: proof.id })] });
    }
    assert.match(tool.content, /当前授权只允许已批准主机/);
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({ facts: [], findings: [], summary: "已回读跨任务的原始前提、反证与当前授权约束" }),
    });
  });
  try {
    await f.run();
    assert.equal(calls, 4);
    assert.equal(f.store.get(id).evidence.length, 1, "causal reads are not new target observations");
    const view = JSON.parse(readFileSync(join(f.dir, "runs", f.job.worker, "view.json"), "utf8")).view;
    const diagnostics = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const metrics = diagnostics.find((event) => event.type === "capacity_plan").data;
    assert.equal(metrics.projection_characters, JSON.stringify(view).length);
    assert.ok(metrics.task_prompt_characters > metrics.projection_characters);
    assert.ok(metrics.task_prompt_utf8_bytes > metrics.task_prompt_characters);
    // The entry budget is tuned from measured sections, not from guesses.
    assert.ok(metrics.projection_sections, "capacity_plan carries per-section characters");
    assert.equal(typeof metrics.projection_sections.facts, "number");
    assert.equal(typeof metrics.projection_sections.instructions, "number");
    assert.ok(metrics.projection_sections.other >= 0);
    // Execute/Review entries have no cold pool; a Decide entry reports the budget.
    if (view.cold) {
      assert.equal(metrics.projection_sections.hot.nodes, view.cold.hot.nodes);
      assert.equal(metrics.projection_sections.hot.chars, view.cold.hot.chars);
    } else {
      assert.equal(metrics.projection_sections.hot, null);
    }
  } finally {
    await f.close();
  }
});

test("Pi Decide reads the exact deletion preview before writing an autonomous deletion batch", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  const step = f.store.manualStep(f.graph.project.id, {
    from: ["origin"],
    description: "Obsolete branch",
    creator: "human",
    claim: true,
  });
  const fact = f.store.fact(f.graph.project.id, step.id, {
    worker: "human",
    description: "Obsolete premise",
    evidence_ids: [],
  });
  const batch = {
    delete_nodes: [
      { id: fact.id, reason: "与当前目标无关" },
      { id: step.id, reason: "放弃此方向" },
    ],
  };
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    calls++;
    if (calls === 2) {
      const result = JSON.parse(req.body.messages.filter((message: any) => message.role === "tool").at(-1).content);
      assert.match(result.settle.conflicts[0].reason, /preview_deletions/);
      assert.ok(!f.store.get(f.graph.project.id).facts.find((record) => record.id === fact.id)!.deleted);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("preview_deletions", batch)] });
    }
    if (calls === 3) {
      const preview = JSON.parse(req.body.messages.filter((message: any) => message.role === "tool").at(-1).content);
      assert.deepEqual(preview.deleted, [fact.id, step.id].sort());
      assert.equal(preview.valid, true);
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("submit_decisions", { delete_nodes: batch.delete_nodes.slice(1) })],
      });
    }
    if (calls === 4) {
      const result = JSON.parse(req.body.messages.filter((message: any) => message.role === "tool").at(-1).content);
      assert.match(result.settle.conflicts[0].reason, /exact delete_nodes batch/);
      assert.ok(!f.store.get(f.graph.project.id).steps[0].deleted);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("preview_deletions", batch)] });
    }
    if (calls === 5) {
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("submit_decisions", batch)] });
    }
    const contract = req.body.tools.find((tool: any) => tool.function.name === "submit_decisions").function.parameters;
    assert.ok(contract.properties.delete_nodes);
    assert.equal(contract.properties.deletion_preview_hash, undefined, "the runtime supplies preview identity");
    streamFixture(reply, { role: "assistant", tool_calls: [toolCall("submit_decisions", batch)] });
  });
  try {
    await f.run();
    // The committed settlement ends the turn; the accepted result is verified
    // through durable graph state instead of one more provider request.
    assert.equal(calls, 5, "no provider request follows the committed settlement");
    assert.equal(
      Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans").get()!.n),
      1,
      "missing/mismatched preview attempts do not write plans",
    );
    assert.equal(f.store.get(f.graph.project.id).evidence.length, 0, "preview reads do not create Evidence");
    assert.equal(
      f.store.get(f.graph.project.id).facts.find((record) => record.id === fact.id)!.deleted?.by,
      f.job.worker,
    );
    assert.equal(f.store.execution.get(f.graph.project.id, f.job.run_id!)!.status, "succeeded");
    assert.ok(!f.store.view(f.graph.project.id).steps.some((record) => record.id === step.id));
  } finally {
    await f.close();
  }
});

test("preview does not acknowledge unseen observations and a settlement conflict requires a fresh preview", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  const step = f.store.manualStep(f.graph.project.id, {
    from: ["origin"],
    description: "Old branch",
    creator: "human",
    claim: true,
  });
  const fact = f.store.fact(f.graph.project.id, step.id, {
    worker: "human",
    description: "Old premise",
    evidence_ids: [],
  });
  const batch = { delete_nodes: [{ id: fact.id, reason: "Remove this premise" }] };
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    calls++;
    const result = () => JSON.parse(req.body.messages.filter((message: any) => message.role === "tool").at(-1).content);
    if (calls === 1) {
      f.store.hint(f.graph.project.id, "New directive after the initial Decide view");
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("preview_deletions", batch)] });
    }
    if (calls === 2) {
      assert.equal(result().valid, true);
      assert.ok(f.store.get(f.graph.project.id).decided_revision < result().observation_revision);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("submit_decisions", batch)] });
    }
    if (calls === 3) {
      assert.ok(result().settle.conflicts.some((conflict: any) => conflict.kind === "snapshot"));
      assert.equal(
        result().current_view.hints.length,
        1,
        "only the returned full view acknowledges the new Hint for this Run",
      );
      assert.ok(!f.store.get(f.graph.project.id).facts.find((record) => record.id === fact.id)!.deleted);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("submit_decisions", batch)] });
    }
    if (calls === 4) {
      assert.match(result().settle.conflicts[0].reason, /preview_deletions/);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("preview_deletions", batch)] });
    }
    if (calls === 5)
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [
          toolCall("submit_decisions", {
            ...batch,
            hint_notes: [{ id: "h001", note: "新指令已纳入删除判断" }],
          }),
        ],
      });
    return streamFixture(reply, { role: "assistant", content: "{}" });
  });
  try {
    await f.run();
    // The final settlement ends the turn before another provider request.
    assert.equal(calls, 5);
    assert.ok(f.store.get(f.graph.project.id).facts.find((record) => record.id === fact.id)!.deleted);
    assert.equal(f.store.get(f.graph.project.id).hints[0].resolved_by, "decide");
    assert.equal(f.store.get(f.graph.project.id).hints[0].notes?.at(-1)?.note, "新指令已纳入删除判断");
  } finally {
    await f.close();
  }
});

test("an empty provider turn is repaired once before it counts as a model failure", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req: any, reply) => {
    calls++;
    // A reasoning-only / blank completion: role chunk, stop, no text, no tool call.
    if (calls === 1) return streamFixture(reply, { role: "assistant" });
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({ steps: [{ from: ["origin"], description: "Recovered after the empty turn" }] }),
    });
  });
  try {
    await f.run();
    assert.equal(calls, 2, "one repair request turns the empty answer into a real result");
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
    const diagnostics = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      diagnostics.some((event) => event.type === "result_repair" && event.data.detail === "empty_final_response"),
      "the empty turn is recorded before the repair",
    );
    assert.ok(
      f.store.get(f.graph.project.id).steps.some((step) => step.description === "Recovered after the empty turn"),
    );
  } finally {
    await f.close();
  }
});

test("a provider-native tool-call envelope fails fast with an actionable mismatch error", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req: any, reply) => {
    calls++;
    if (calls === 1)
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("query </think>", { kind: "facts" })],
      });
    return streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({ steps: [{ from: ["origin"], description: "Should not be reached" }] }),
    });
  });
  try {
    await assert.rejects(f.run(), /tool-call protocol mismatch/);
    assert.equal(calls, 2, "one corrective turn, then the actionable failure");
    const diagnostics = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(diagnostics.some((event) => event.type === "tool_protocol_mismatch"));
  } finally {
    await f.close();
  }
});

test("queuing preview and deletion together cannot write before a model turn observes the impact", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  const step = f.store.manualStep(f.graph.project.id, {
    from: ["origin"],
    description: "Shared branch",
    creator: "human",
  });
  const batch = { delete_nodes: [{ id: step.id, reason: "Remove this branch", cascade: "downstream" }] };
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    calls++;
    if (calls === 1)
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("preview_deletions", batch), toolCall("submit_decisions", batch, 1)],
      });
    const result = JSON.parse(req.body.messages.filter((message: any) => message.role === "tool").at(-1).content);
    if (calls === 2) {
      assert.equal(result.settle.ok, false);
      assert.match(result.settle.conflicts[0].reason, /subsequent model turn/);
      assert.equal(f.store.get(f.graph.project.id).steps[0].deleted, undefined);
      assert.equal(Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans").get()!.n), 0);
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("submit_decisions", batch)] });
    }
    return streamFixture(reply, { role: "assistant", content: "{}" });
  });
  try {
    await f.run();
    assert.equal(calls, 2, "the committed settlement ends the turn without another provider request");
    assert.ok(f.store.get(f.graph.project.id).steps[0].deleted);
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Decide final JSON uses the same deletion-preview gate as submit_decisions", async () => {
  for (const previewed of [false, true]) {
    const f = await sdkFixture("decide");
    let calls = 0;
    const step = f.store.manualStep(f.graph.project.id, {
      from: ["origin"],
      description: "Final JSON branch",
      creator: "human",
    });
    const batch = { delete_nodes: [{ id: step.id, reason: "Remove this branch" }] };
    f.model.post("/v1/chat/completions", async (_req: any, reply) => {
      if (++calls === 1 && previewed)
        return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("preview_deletions", batch)] });
      return streamFixture(reply, { role: "assistant", content: JSON.stringify(batch) });
    });
    try {
      await f.run();
      const graph = f.store.get(f.graph.project.id);
      assert.equal(!!graph.steps[0].deleted, previewed);
      assert.equal(Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM platform_plans").get()!.n), previewed ? 1 : 0);
      assert.equal(calls, previewed ? 2 : 1);
      if (!previewed) assert.equal(graph.project.decide_conflicts, 1);
    } finally {
      await f.close();
    }
  }
});

test("in-flight Pi queries exclude deleted bodies and the model cannot read historical originals", async () => {
  const f = await sdkFixture();
  let calls = 0;
  const target = f.store.manualStep(f.graph.project.id, {
    from: ["origin"],
    description: "Historical producer",
    creator: "human",
    claim: true,
  });
  const fact = f.store.fact(f.graph.project.id, target.id, {
    worker: "human",
    description: "REMOVED_RUNNER_BODY",
    evidence_ids: [],
  });
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    calls++;
    const lastContent = () =>
      String(req.body.messages.filter((message: any) => message.role === "tool").at(-1)?.content ?? "");
    const result = () => JSON.parse(lastContent());
    if (calls === 1) {
      const planner = f.store.claim(f.graph.project.id, "concurrent-planner", 0)!,
        graph = f.store.get(f.graph.project.id);
      assert.equal(planner.kind, "decide");
      f.store.submitDecisions(
        f.graph.project.id,
        submitDecisionsSchema.parse({
          worker: planner.worker,
          submission_id: "delete-during-run",
          revision: graph.revision,
          observation_revision: graph.observation_revision,
          planning_revision: graph.planning_revision,
          delete_nodes: [{ id: fact.id, reason: "Retire obsolete material" }],
        }),
        planner.run_id,
      );
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("query_graph", { kind: "facts", mode: "query" })],
      });
    }
    if (calls === 2) {
      assert.ok(!JSON.stringify(result()).includes("REMOVED_RUNNER_BODY"));
      assert.ok(!result().items.some((item: any) => item.id === fact.id));
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", { id: fact.id })] });
    }
    if (calls === 3) {
      assert.equal(result().deleted, true);
      assert.ok(!JSON.stringify(result()).includes("REMOVED_RUNNER_BODY"));
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("read_graph", { id: fact.id, history: true })],
      });
    }
    if (calls === 4) {
      assert.match(lastContent(), /operator-only/);
      assert.ok(!lastContent().includes("REMOVED_RUNNER_BODY"));
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("query_graph", { kind: "facts", keyword: "REMOVED_RUNNER_BODY", history: true })],
      });
    }
    if (calls === 5) {
      assert.match(lastContent(), /operator-only/);
      assert.ok(!lastContent().includes("REMOVED_RUNNER_BODY"));
      const event = f.store.events(f.graph.project.id).find((event) => event.kind === "fact.observed")!;
      return streamFixture(reply, {
        role: "assistant",
        tool_calls: [toolCall("read_change", { event_seq: event.seq })],
      });
    }
    if (calls === 6) {
      assert.ok(!lastContent().includes("REMOVED_RUNNER_BODY"));
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", {})] });
    }
    assert.ok(!JSON.stringify(result()).includes("REMOVED_RUNNER_BODY"));
    streamFixture(reply, { role: "assistant", content: '{"summary":"活动图已刷新，继续基于当前状态执行"}' });
  });
  try {
    await f.run();
    assert.equal(calls, 7);
    assert.equal(
      f.store.get(f.graph.project.id).evidence.length,
      0,
      "graph/history reads must not republish historical bodies as new Evidence",
    );
    assert.equal(
      f.store.get(f.graph.project.id).facts.find((record) => record.id === fact.id)!.deleted?.by,
      "concurrent-planner",
    );
    assert.equal(f.store.execution.get(f.graph.project.id, f.job.run_id!)!.status, "succeeded");
  } finally {
    await f.close();
  }
});

for (const id of ["fixture", "glm-5"])
  test(`${id} uses Pi output sizing and Pi's compaction defaults without changing normal transport`, async () => {
    const f = await sdkFixture();
    let calls = 0;
    f.config.model.id = id;
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      calls++;
      const output = req.body.max_tokens ?? req.body.max_completion_tokens;
      assert.ok(
        output > f.config.model.context_window * 0.08,
        "the old percentage cap must not limit an ordinary response",
      );
      assert.ok(
        output <= f.config.model.context_window - 4096,
        "Pi leaves room for request input and its safety margin",
      );
      assert.equal(output, 16384, "custom endpoints use a conservative output cap");
      assert.equal(req.body.stream, true);
      assert.equal(req.body.response_format, undefined);
      streamFixture(reply, { role: "assistant", content: '{"summary":"由 Pi 管理模型请求"}' });
    });
    try {
      await f.run();
      assert.equal(calls, 1);
      const events = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const capacity = events.find((event) => event.type === "capacity_plan").data;
      const defaults = SettingsManager.inMemory().getCompactionSettings();
      // Pi owns the compaction budget; Tessera must not scale it to the window.
      assert.equal(capacity.reserve, defaults.reserveTokens);
      assert.equal(capacity.keep_recent, defaults.keepRecentTokens);
      assert.equal(capacity.compaction_enabled, defaults.enabled);
      assert.ok(!events.some((event) => event.type === "closeout" || event.type === "compaction_start"));
    } finally {
      await f.close();
    }
  });

test("a custom gateway does not borrow a same-ID model's limits from another provider", async () => {
  const f = await sdkFixture();
  f.config.model.id = "deepseek-ai/DeepSeek-V3";
  f.config.model.context_window = 128000;
  f.model.post("/v1/chat/completions", async (_req: any, reply) => {
    streamFixture(reply, { role: "assistant", content: '{"summary":"使用较小窗口"}' });
  });
  try {
    await f.run();
    const events = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const capacity = events.find((event) => event.type === "capacity_plan").data;
    assert.equal(capacity.window, 128000, "an unrelated public deployment cannot determine the gateway window");
    assert.equal(capacity.max_output, 16384, "unknown gateways use the Pi custom model output default");
  } finally {
    await f.close();
  }
});

for (const provider of ["zai", "deepseek", "minimax"])
  test(`Pi native ${provider} runs a tool turn and reports the same limits as settings`, async () => {
    const f = await sdkFixture();
    const native = (await modelCatalog({ ...f.config.model, provider, base_url: "" }))[0];
    Object.assign(f.config.model, { provider, id: native.id, api: native.api, max_output_tokens: 4096 });
    const expected = await modelMetadata(f.config.model);
    let calls = 0;
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      assert.equal(req.body.max_tokens, 4096);
      assert.equal(req.body.model, native.id);
      assert.equal(req.body.messages[0].role, "system");
      if (++calls === 1) return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", {})] });
      assert.equal(req.body.messages.at(-1).role, "tool");
      if (provider === "deepseek")
        assert.equal(typeof req.body.messages.find((m: any) => m.role === "assistant").reasoning_content, "string");
      return streamFixture(reply, { role: "assistant", content: '{"summary":"Pi 原生供应商工具流程完成"}' });
    });
    f.model.post("/v1/messages", async (req: any, reply) => {
      assert.equal(req.body.model, native.id);
      assert.equal(req.body.max_tokens, 4096);
      const first = ++calls === 1;
      if (!first) assert.ok(req.body.messages.at(-1).content.some((c: any) => c.type === "tool_result"));
      const events = [
        {
          type: "message_start",
          message: {
            id: "native",
            type: "message",
            role: "assistant",
            model: native.id,
            content: [],
            usage: { input_tokens: 1000, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: first
            ? { type: "tool_use", id: "read_graph_1", name: "read_graph", input: {} }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: first
            ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text: '{"summary":"Pi 原生供应商工具流程完成"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: first ? "tool_use" : "end_turn" },
          usage: { output_tokens: 30 },
        },
        { type: "message_stop" },
      ];
      return reply
        .header("content-type", "text/event-stream")
        .send(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
    try {
      await f.run();
      assert.equal(calls, 2);
      const events = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const plan = events.find((e) => e.type === "capacity_plan").data;
      assert.equal(plan.provider, expected.provider);
      assert.equal(plan.api, expected.api);
      assert.equal(plan.window, expected.context_window);
      assert.equal(plan.max_output, expected.max_output_tokens);
      assert.equal(f.store.get(f.graph.project.id).steps[0].summary, "Pi 原生供应商工具流程完成");
    } finally {
      await f.close();
    }
  });

test("a large refreshed graph view remains valid JSON with the complete current question", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.config.model.context_window = 128000;
  const question = "BEGIN\n" + "当前问题需要完整交付。".repeat(1800) + "\nEND";
  f.store.mutate(f.graph.project.id, "", false, (graph) => {
    graph.steps[0].description = question;
  });
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1) return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", {})] });
    const tool = req.body.messages.filter((message: any) => message.role === "tool").at(-1);
    assert.ok(tool.content.length > 12000);
    assert.equal(JSON.parse(tool.content).focus.description, question);
    streamFixture(reply, { role: "assistant", content: '{"summary":"完整问题已回读"}' });
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    assert.equal(
      f.store.get(f.graph.project.id).evidence.length,
      0,
      "reading graph state must not manufacture an Evidence original",
    );
  } finally {
    await f.close();
  }
});

test("Pi integrates optional bookmarks and read-only references while preserving role tool sets", async () => {
  for (const kind of ["execute", "decide", "review"] as const) {
    const f = await sdkFixture(kind);
    let calls = 0;
    writeFileSync(join(f.dir, "scan.ndjson"), '{"observation":"original marker"}\n');
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      const names = req.body.tools.map((t: any) => t.function.name);
      assertTaskRequest(req.body, names);
      assert.equal(names.includes("submit_decisions"), kind === "decide");
      assert.equal(names.includes("preview_deletions"), kind === "decide");
      assert.equal(names.includes("submit_fact"), kind === "execute");
      // Providers reject any tool whose parameters are not an object schema
      // (e.g. a top-level anyOf without "type": "object").
      for (const advertised of req.body.tools)
        assert.equal(
          advertised.function.parameters?.type,
          "object",
          `${advertised.function.name} parameters must be an object schema`,
        );
      assert.ok(names.includes("mark_node"));
      assert.ok(names.includes("query_references"));
      assert.ok(names.includes("read_reference"));
      assert.equal(names.includes("read_artifact"), false);
      assert.equal(names.includes("read_workspace"), kind === "execute");
      assert.equal(names.includes("bash"), kind === "execute");
      const previous = JSON.stringify(req.body.messages.filter((m: any) => m.role === "tool"));
      let call;
      switch (++calls) {
        case 1:
          call = toolCall("mark_node", {
            node_id: "origin",
            expected_version: 0,
            reason: "后续核对访问条件",
            revisit_when: "相关事实变化时",
          });
          break;
        case 2:
          assert.match(previous, /bookmark_/);
          call = toolCall("query_graph", { kind: "bookmarks", refresh: true });
          break;
        case 3:
          assert.match(previous, /node_id/);
          call = toolCall("read_graph", { id: f.store.get(f.graph.project.id).bookmarks![0].id });
          break;
        case 4:
          call = toolCall("query_references", { keyword: "工具输出" });
          break;
        case 5:
          assert.match(previous, /tool-artifacts/);
          call = toolCall("read_reference", { id: "tool-artifacts" });
          break;
        case 6:
          assert.match(previous, /参考|原始/);
          if (kind === "execute") call = toolCall("read_workspace", { path: "scan.ndjson" });
          break;
        default:
          assert.match(previous, /original marker/);
      }
      streamFixture(
        reply,
        {
          role: "assistant",
          ...(call
            ? { tool_calls: [call] }
            : {
                content: JSON.stringify(
                  kind === "execute"
                    ? { summary: "回读原始材料完成" }
                    : kind === "review"
                      ? { verdict: "needs_evidence", reason: "Existing claim lacks original proof" }
                      : {},
                ),
              }),
        },
        3000,
      );
    });
    try {
      await f.run();
      assert.equal(f.store.get(f.graph.project.id).bookmarks!.length, 1);
      assert.equal(
        f.store.runs(f.graph.project.id).find((r) => r.id === f.job.run_id)!.external_action_possible,
        false,
      );
      assert.equal(f.store.runs(f.graph.project.id).find((r) => r.id === f.job.run_id)!.status, "succeeded");
    } finally {
      await f.close();
    }
  }
});

test("mark_node enforces the server bookmark rules inside the run", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    const mark = req.body.tools.find((t: any) => t.function.name === "mark_node");
    assert.equal(mark.function.parameters.type, "object");
    assert.equal(mark.function.parameters.anyOf, undefined);
    const previous = JSON.stringify(req.body.messages.filter((m: any) => m.role === "tool"));
    let call;
    switch (++calls) {
      case 1:
        call = toolCall("mark_node", { node_id: "origin", expected_version: 0 });
        break;
      case 2:
        assert.match(previous, /Active bookmarks require reason and revisit_when/);
        call = toolCall("mark_node", {
          node_id: "origin",
          expected_version: 0,
          reason: "关注访问条件",
          revisit_when: "事实变化时",
        });
        break;
      case 3:
        call = toolCall("mark_node", { node_id: "origin", expected_version: 1, withdraw: true });
        break;
      default:
        assert.match(previous, /withdrawn_at/);
    }
    streamFixture(
      reply,
      {
        role: "assistant",
        ...(call ? { tool_calls: [call] } : { content: JSON.stringify({ summary: "书签创建与撤销完成" }) }),
      },
      3000,
    );
  });
  try {
    await f.run();
    const bookmarks = f.store.get(f.graph.project.id).bookmarks!;
    assert.equal(bookmarks.length, 1);
    assert.equal(typeof bookmarks[0].withdrawn_at, "string");
    assert.equal(bookmarks[0].version, 2);
  } finally {
    await f.close();
  }
});

test("result repair rejects bookmark, reference and shell calls before side effects", async () => {
  const f = await sdkFixture();
  let calls = 0;
  writeFileSync(join(f.dir, "scan.json"), '{"secret_marker":"should not be read during repair"}');
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1) return streamFixture(reply, { role: "assistant", content: "not a result envelope" }, 3000);
    if (calls === 2)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("mark_node", {
              node_id: "origin",
              expected_version: 0,
              reason: "关注",
              revisit_when: "条件变化时",
            }),
            toolCall("read_reference", { id: "tool-artifacts" }, 1),
            toolCall("bash", { command: "cat scan.json" }, 2),
          ],
        },
        3000,
      );
    assert.match(JSON.stringify(req.body.messages), /Closeout permits/);
    assert.doesNotMatch(JSON.stringify(req.body.messages), /secret_marker/);
    streamFixture(reply, { role: "assistant", content: '{"summary":"仅用现有材料序列化"}' }, 3000);
  });
  try {
    await f.run();
    assert.equal(calls, 3);
    assert.equal(f.store.get(f.graph.project.id).bookmarks, undefined);
  } finally {
    await f.close();
  }
});

test("invalid root/complete plans are caught before submission and get the existing single read-only repair", async () => {
  for (const invalid of [
    { goals: [{ id: "goal", description: "完成", state: "satisfied" }] },
    { steps: [{ from: ["origin"], description: "未执行任务" }] },
  ]) {
    const f = await sdkFixture("decide");
    let calls = 0;
    let toolNames: string[];
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      toolNames ??= req.body.tools.map((t: any) => t.function.name);
      assertTaskRequest(req.body, toolNames);
      assert.ok(!toolNames.includes("bash") && !toolNames.includes("write"));
      calls++;
      if (calls === 1)
        return streamFixture(
          reply,
          {
            role: "assistant",
            content: JSON.stringify({
              ...invalid,
              complete: { from: ["origin"], description: "原始依据足够" },
            }),
          },
          3000,
        );
      assert.match(JSON.stringify(req.body.messages), /结果序列化失败/);
      streamFixture(
        reply,
        { role: "assistant", content: '{"complete":{"from":["origin"],"description":"依据原始观测完成"}}' },
        3000,
      );
    });
    try {
      await f.run();
      assert.equal(calls, 2);
      assert.equal(f.store.get(f.graph.project.id).project.status, "completed");
      const saved = JSON.parse(readFileSync(join(f.dir, "runs", f.job.worker, "pending-result.json"), "utf8"));
      const record = JSON.parse(readFileSync(join(f.dir, "runs", f.job.worker, saved.submission_file), "utf8"));
      assert.equal(record.state, "accepted");
      assert.deepEqual(record.payload.goals, []);
    } finally {
      await f.close();
    }
  }
});

test("Execute delegates pressure to Pi, accounts summaries and observes a lower generation", async () => {
  const f = await sdkFixture();
  let task = 0,
    summaries = 0;
  let toolNames: string[];
  f.config.task_timeout_seconds = 15;
  f.config.closeout_seconds = 2;
  f.store.bookmark(f.graph.project.id, f.job.run_id!, {
    worker: f.job.worker,
    node_id: "origin",
    expected_version: 0,
    reason: "压缩后核对原文",
    revisit_when: "压缩完成后",
    withdraw: false,
  });
  // Supply enough real history for Pi's recent-message split, rather than only falsifying usage.
  f.store.mutate(f.graph.project.id, "", false, (g) => {
    g.steps[0].description = "Existing task context. ".repeat(700);
  });
  f.model.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as any;
    if (!body.tools?.length) {
      summaries++;
      streamFixture(
        reply,
        {
          role: "assistant",
          content:
            "## Goal\nPreserve existing observation and original source origin.\n## Progress\nRead origin; finish with original evidence.\n## Next Steps\nReturn execute JSON.",
        },
        5000,
      );
    } else if (++task === 1) {
      toolNames = body.tools.map((t: any) => t.function.name);
      assertTaskRequest(body, toolNames);
      streamFixture(
        reply,
        {
          role: "assistant",
          content: "Existing observation for compaction. ".repeat(3000),
          tool_calls: [toolCall("read_graph", { id: "origin" })],
        },
        28000,
      );
    } else {
      assertTaskRequest(body, toolNames);
      if (task === 2)
        streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", { id: "origin" })] }, 4000);
      else
        streamFixture(
          reply,
          { role: "assistant", content: JSON.stringify({ summary: "压缩后依据原始记录完成", facts: [] }) },
          4000,
        );
    }
  });
  try {
    await f.run();
    assert.equal(task, 3);
    assert.ok(summaries > 0);
    const run = f.store.runs(f.graph.project.id)[0];
    assert.equal(run.request_count, task + summaries);
    const events = readFileSync(join(f.dir, "runs", f.job.worker, "diagnostics.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.ok(events.some((e) => e.type === "compaction_end" && e.data.known === false && e.data.generation === 1));
    assert.ok(events.some((e) => e.type === "context_usage" && e.data.current < 10000 && e.data.peak > 26000));
    assert.ok(!events.some((e) => e.type === "closeout"));
    assert.ok(f.store.get(f.graph.project.id).steps[0].executed_at);
    assert.equal(f.store.get(f.graph.project.id).steps[0].concluded_at, null);
    const exported = await f.app.inject(`/api/projects/${f.graph.project.id}/diagnostics`);
    const rows = gunzipSync(exported.rawPayload)
      .toString()
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.equal(rows[0].schema, "tessera.diagnostics.v2");
    assert.equal(rows.filter((r) => r.type === "model_request_end").length, task + summaries);
    assert.equal(
      rows.filter((r) => r.type === "model_request_end" && r.data.purpose === "compaction").length,
      summaries,
    );
    const source = rows.find((r) => r.type === "run_diagnostic_summary" && r.run_id === f.job.run_id).sources[0];
    assert.equal(source.sequence_complete, true);
    const traces = new Map<string, any[]>();
    for (const row of rows.filter((r) => r.type === "validation_trace"))
      traces.set(row.data.trace_id, [...(traces.get(row.data.trace_id) ?? []), row.data]);
    const payloads = [...traces.values()].map((parts) => {
      parts.sort((a, b) => a.part - b.part);
      assert.equal(parts.length, parts[0].parts);
      assert.equal(parts[0].truncated, false);
      const content = parts.map((p) => p.content).join("");
      return { ...parts[0], value: parts[0].format === "json" ? JSON.parse(content) : content };
    });
    assert.ok(payloads.some((t) => t.kind === "initial_entry"));
    assert.ok(payloads.some((t) => t.kind === "runtime_policy" && t.value.enabled === true));
    assert.ok(payloads.some((t) => t.kind === "graph_inventory" && t.value.kind === "facts"));
    assert.ok(
      payloads.some(
        (t) =>
          t.kind === "navigation_anchors" &&
          t.value.phase === "before_compaction" &&
          t.value.bookmarks[0].bookmark.node_id === "origin",
      ),
    );
    assert.ok(payloads.some((t) => t.kind === "compaction_summary" && t.value.includes("original source origin")));
    assert.ok(payloads.some((t) => t.kind === "memory_tool" && t.generation === 1 && t.value.args.id === "origin"));
    assert.ok(payloads.some((t) => t.kind === "final_payload" && t.value.summary.includes("原始记录")));
    assert.ok(rows.some((r) => r.type === "submission" && r.data.stage === "prepared" && r.data.final));
    assert.ok(rows.some((r) => r.type === "submission" && r.data.stage === "attempt_accepted"));
    assert.ok(!JSON.stringify(rows).includes(testWorkerToken));
  } finally {
    await f.close();
  }
});

test("Pi summary failure uses read-only recovery", async () => {
  const f = await sdkFixture();
  let task = 0,
    summaries = 0;
  f.config.task_timeout_seconds = 15;
  f.config.closeout_seconds = 5;
  f.model.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as any;
    if (!body.tools?.length) {
      summaries++;
      return reply.code(402).send({ error: { message: "summary quota failed" } });
    }
    if (++task === 1)
      return streamFixture(
        reply,
        {
          role: "assistant",
          content: "Existing observation for compaction. ".repeat(3000),
          tool_calls: [toolCall("read_graph", { id: "origin" })],
        },
        28000,
      );
    if (task === 2)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("write", { path: join(f.dir, "forbidden.txt"), content: "forbidden" }),
            toolCall(
              "submit_fact",
              { description: "must not persist", conclusion: "Should not persist", evidence_ids: [] },
              1,
            ),
            toolCall("read_graph", { id: "origin" }, 2),
          ],
        },
        4000,
      );
    return streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ summary: "保留现有材料并说明未完成问题", facts: [] }) },
      4000,
    );
  });
  try {
    await f.run();
    assert.equal(summaries, 1);
    assert.equal(task, 3);
    assert.equal(existsSync(join(f.dir, "forbidden.txt")), false);
    const g = f.store.get(f.graph.project.id);
    assert.ok(!g.facts.some((fact) => fact.description === "must not persist"));
    const run = f.store.runs(g.project.id)[0];
    assert.equal(run.external_action_possible, false);
    // Usage is recorded, but the application no longer derives a token-threshold closeout.
  } finally {
    await f.close();
  }
});

test("a model-echoed read_only cannot suppress or invalidate a normal Execute result", async () => {
  const f = await sdkFixture();
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    streamFixture(
      reply,
      {
        role: "assistant",
        content: JSON.stringify({
          summary: "只读复核完成，但本 Run 不是恢复会话",
          facts: ["已确认的观测"],
          leads: [{ surface: "GET /api/thing", why: "值得核查", suggested_property: "若返回 200 则成立" }],
          read_only: true,
        }),
      },
      1000,
    );
  });
  try {
    await f.run();
    const g = f.store.get(f.graph.project.id);
    assert.ok(g.steps[0].executed_at, "the Step records the final result");
    assert.ok(g.facts.some((fact) => fact.description === "已确认的观测"));
    assert.equal(f.store.runs(g.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Execute closeout blocks queued world tools and saves original evidence before finishing", async () => {
  const f = await sdkFixture();
  f.config.task_timeout_seconds = 5;
  f.config.closeout_seconds = 4;
  writeFileSync(join(f.dir, "AGENTS.md"), "仓库上下文不应加载：只用英文输出，禁止改变界面布局。");
  writeFileSync(join(f.dir, "raw.txt"), "Original independently checkable proof");
  let calls = 0;
  f.model.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as any;
    assert.ok(
      !JSON.stringify(body.messages.filter((m: any) => m.role === "system")).includes("expert coding assistant"),
    );
    assert.match(JSON.stringify(body.messages.filter((m: any) => m.role === "system")), /简体中文/);
    assert.ok(!JSON.stringify(body.messages).includes("仓库上下文不应加载"));
    if (++calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("save_evidence", { path: "raw.txt", title: "Original proof" }),
            toolCall("write", { path: join(f.dir, "forbidden.txt"), content: "must not run" }, 1),
          ],
        },
        1000,
      );
    } else {
      assert.ok(
        body.tools.some((t: any) => t.function.name === "bash"),
        "declarations stay stable; admission enforces permissions",
      );
      assert.match(JSON.stringify(body.messages), /立即停止探索/);
      if (calls === 2)
        streamFixture(reply, {
          role: "assistant",
          tool_calls: [
            toolCall("submit_fact", {
              description: "Verified original proof",
              conclusion: "Original proof is verified",
              evidence_ids: [f.store.get(f.graph.project.id).evidence.find((e) => e.title === "Original proof")!.id],
            }),
          ],
        });
      else
        streamFixture(
          reply,
          {
            role: "assistant",
            content: JSON.stringify({ facts: [], summary: "Saved original proof; remaining questions go to Decide" }),
          },
          1000,
        );
    }
  });
  try {
    await f.run();
    const result = f.store.get(f.graph.project.id);
    assert.equal(calls, 3);
    assert.equal(existsSync(join(f.dir, "forbidden.txt")), false);
    assert.equal(result.steps[0].fact_ids.length, 1);
    assert.ok(result.steps[0].executed_at);
    assert.equal(result.steps[0].concluded_at, null);
    const evidence = result.evidence.find((e) => e.title === "Original proof")!;
    assert.equal(
      f.store.evidenceContent(f.graph.project.id, evidence.id).bytes.toString(),
      "Original independently checkable proof",
    );
    assert.deepEqual(result.facts.at(-1)!.evidence_ids, [evidence.id]);
  } finally {
    await f.close();
  }
});

test("persisted Execute session recovers once with reads only, unique usage and replayable final", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.config.closeout_seconds = 5;
  f.model.post("/v1/chat/completions", async (req, reply) => {
    if (++calls === 1) return reply.code(402).send({ error: { message: "original request failed" } });
    assertTaskRequest(req.body, ["read_graph", "read_evidence", "read_workspace", "query_traffic"]);
    if (calls === 2)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("write", { path: join(f.dir, "forbidden.txt"), content: "blocked" }),
            toolCall(
              "submit_fact",
              { description: "must not persist", conclusion: "Should not persist", evidence_ids: [] },
              1,
            ),
            toolCall("read_graph", { id: "origin" }, 2),
          ],
        },
        1000,
      );
    streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ summary: "只读恢复保留依据", facts: [] }) },
      1500,
    );
  });
  try {
    await assert.rejects(f.run(), /original request failed/);
    const file = join(f.dir, "runs", f.job.worker, "recovery.json");
    const client = new ApiClient(f.app.listeningOrigin, testWorkerToken);
    await recoverReadOnly(file, f.config, client);
    const g = f.store.get(f.graph.project.id),
      run = f.store.runs(g.project.id)[0];
    assert.equal(calls, 3);
    assert.equal(run.request_count, 3);
    assert.equal(run.status, "succeeded");
    assert.equal(run.external_action_possible, false);
    assert.equal(existsSync(join(f.dir, "forbidden.txt")), false);
    assert.equal(g.steps[0].executed_at, null, "recovery must not claim the Step was executed");
    assert.ok(!g.facts.some((fact) => fact.description === "must not persist"));
    await recoverReadOnly(file, f.config, client);
    assert.equal(calls, 3, "saved final replays without restarting the model even after the lease ends");
  } finally {
    await f.close();
  }
});

test("read-only recovery refuses expired/blocked Run before any model request", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    calls++;
    return reply.code(402).send({ error: { message: "failed" } });
  });
  try {
    await assert.rejects(f.run());
    f.store.externalAction(f.graph.project.id, f.job);
    f.store.release(f.graph.project.id, f.job, "interrupted after possible action");
    await assert.rejects(
      recoverReadOnly(
        join(f.dir, "runs", f.job.worker, "recovery.json"),
        f.config,
        new ApiClient(f.app.listeningOrigin, testWorkerToken),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(f.store.get(f.graph.project.id).steps[0].blocked_run_id, f.job.run_id);
  } finally {
    await f.close();
  }
});

test("uncooperative closeout is bounded and never fabricates a completed Step", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.config.task_timeout_seconds = 5;
  f.config.closeout_seconds = 4;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 1100));
    streamFixture(
      reply,
      {
        role: "assistant",
        tool_calls: [
          toolCall("submit_fact", {
            description: `Observation ${calls}`,
            conclusion: `Observation ${calls}`,
            evidence_ids: [],
          }),
        ],
      },
      1000,
    );
  });
  try {
    const started = Date.now();
    await assert.rejects(f.run(), /Task timeout|Closeout/);
    assert.ok(
      Date.now() - started < 15000,
      "the five-second Run must abort and flush diagnostics within a bounded grace period",
    );
    const step = f.store.get(f.graph.project.id).steps[0];
    assert.equal(step.concluded_at, null);
    assert.ok(step.fact_ids.length > 0);
  } finally {
    await f.close();
  }
});

test("time closeout stops a running command but still accepts the final result", async () => {
  const f = await sdkFixture();
  f.config.task_timeout_seconds = 6;
  f.config.closeout_seconds = 2;
  let calls = 0,
    processId = "";
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("bash", {
              command: "node -e \"setTimeout(()=>console.log('late'),30000)\"",
              yield_time_ms: 0,
            }),
          ],
        },
        500,
      );
    if (!processId) {
      const tool = req.body.messages.filter((m: any) => m.role === "tool").at(-1);
      processId = JSON.parse(tool.content).process_id;
    }
    // Wait for the actual transition. A fixed delay races the exploration timer,
    // and repeating that delay for the queued steer turn can exhaust closeout.
    if (calls === 2) {
      const diagnostics = join(f.dir, "runs", f.job.worker, "diagnostics.ndjson");
      for (let attempt = 0; attempt < 200; attempt++) {
        if (existsSync(diagnostics) && readFileSync(diagnostics, "utf8").includes('"type":"closeout"')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.match(readFileSync(diagnostics, "utf8"), /"type":"closeout"/);
    }
    streamFixture(reply, { role: "assistant", content: JSON.stringify({ summary: "收尾成功", facts: [] }) }, 500);
  });
  try {
    await f.run();
    const graph = f.store.get(f.graph.project.id);
    assert.ok(graph.steps[0].executed_at, "the Step records the final result");
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
    assert.ok(processId);
    assert.ok(
      existsSync(join(f.dir, "runs", f.job.worker, "processes", processId + ".log")),
      "the stopped command log stays in the project workspace",
    );
    assert.ok(
      !graph.evidence.some((e) => e.source_path?.includes("processes")),
      "a process log is not Evidence unless explicitly saved and cited",
    );
    const metadata = JSON.parse(
      readFileSync(join(f.dir, "runs", f.job.worker, "processes", processId + ".json"), "utf8"),
    );
    assert.ok(["stopped", "timed_out"].includes(metadata.status), "the command is no longer running");
    assert.match(graph.steps[0].summary!, /收尾成功/);
  } finally {
    await f.close();
  }
});

test("closeout blocks world tools in a queued batch but allows reads and submissions", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.config.task_timeout_seconds = 5;
  f.config.closeout_seconds = 4;
  f.store.addEvidence(f.graph.project.id, {
    title: "Existing raw record",
    content: '"\\'.repeat(6000),
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.model.post("/v1/chat/completions", async (_req: any, reply) => {
    if (++calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("write", { path: join(f.dir, "forbidden.txt"), content: "must not run" }),
            ...Array.from({ length: 6 }, (_, i) => toolCall("read_evidence", { id: "e001", offset: i * 1000 }, i)),
            ...Array.from({ length: 6 }, (_, i) =>
              toolCall(
                "submit_fact",
                {
                  description: `Closeout observation ${i}`,
                  conclusion: `Closeout observation ${i}`,
                  evidence_ids: ["e001"],
                },
                6 + i,
              ),
            ),
          ],
        },
        1000,
      );
    }
    streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ summary: "收尾保留已提交材料", facts: [] }) },
      1000,
    );
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    const g = f.store.get(f.graph.project.id);
    assert.equal(existsSync(join(f.dir, "forbidden.txt")), false, "world tools stay blocked during closeout");
    assert.equal(
      g.facts.filter((fact) => fact.description.startsWith("Closeout observation")).length,
      6,
      "no application-side read/call quota drops submissions",
    );
    assert.ok(g.steps[0].executed_at);
    assert.equal(g.steps[0].concluded_at, null);
  } finally {
    await f.close();
  }
});

test("a deterministic Execute capacity failure isolates its Run and preserves other project work", async () => {
  const f = await sdkFixture();
  try {
    f.store.release(f.graph.project.id, f.job, "Context capacity blocked: fixed tools exceed the available window");
    const graph = f.store.get(f.graph.project.id),
      run = f.store.runs(graph.project.id)[0];
    assert.equal(graph.project.status, "active");
    assert.equal(graph.project.model_failures ?? 0, 0);
    assert.equal(run.status, "needs_attention");
    assert.equal(run.external_action_possible, false);
    assert.equal(graph.steps[0].blocked_run_id, run.id);
    assert.equal(graph.steps[0].worker, null);
    assert.equal(graph.steps[0].concluded_at, null);
  } finally {
    await f.close();
  }
});

test("evidence pages retain their full requested text and do not create duplicate originals", async () => {
  const f = await sdkFixture();
  let calls = 0;
  const original = "raw evidence ".repeat(2000);
  f.store.addEvidence(f.graph.project.id, {
    title: "Long original",
    content: original,
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.model.post("/v1/chat/completions", async (req, reply) => {
    if (++calls === 1)
      streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_evidence", { id: "e001" })] }, 1000);
    else {
      const tool = (req.body as any).messages.filter((m: any) => m.role === "tool").at(-1);
      assert.equal(tool.content, original.slice(0, 12000) + "\n[More evidence: use offset 12000]");
      streamFixture(
        reply,
        { role: "assistant", content: JSON.stringify({ facts: [], summary: "Original output saved" }) },
        2000,
      );
    }
  });
  try {
    await f.run();
    assert.equal(f.store.evidenceContent(f.graph.project.id, "e001").bytes.toString(), original);
    assert.equal(f.store.get(f.graph.project.id).evidence.length, 1);
  } finally {
    await f.close();
  }
});

test("workspace reads page Unicode, expose binary metadata and reject directories", async () => {
  const f = await sdkFixture();
  let calls = 0;
  const original = "已有本地材料🙂".repeat(100);
  writeFileSync(join(f.dir, "local.txt"), original);
  writeFileSync(join(f.dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("read_workspace", { path: "local.txt", offset: 3, limit: 50 }),
            toolCall("read_workspace", { path: "binary.bin" }, 1),
            toolCall("read_workspace", { path: "runs" }, 2),
          ],
        },
        1000,
      );
    const texts = req.body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    const page = JSON.parse(texts.find((text: string) => text.includes('"next_offset"')));
    assert.equal(page.text, original.slice(3, 53));
    assert.equal(page.next_offset, 53);
    assert.ok(texts.some((text: string) => text.includes('"binary":true') && text.includes('"bytes":4')));
    assert.ok(texts.some((text: string) => /regular file/.test(text)));
    streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ summary: "已读取本地原文", facts: [] }) },
      1000,
    );
  });
  try {
    await f.run();
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("Pi provider failures preserve their cause and redact credentials", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    calls++;
    return reply
      .code(402)
      .send({ error: { type: "insufficient_balance_error", message: "quota exhausted fixture-key" } });
  });
  try {
    await assert.rejects(f.run(), (error) => {
      assert.match(String(error), /Model provider failure: 402/);
      assert.ok(!String(error).includes("fixture-key"));
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("model-list API returns actionable and redacted provider errors", async () => {
  const f = await sdkFixture();
  f.model.get("/v1/models", async (_req, reply) =>
    reply.code(402).send({ error: { type: "insufficient_balance_error", message: "quota exhausted fixture-key" } }),
  );
  try {
    await f.model.listen({ host: "127.0.0.1", port: 0 });
    const response = await f.app.inject({
      method: "POST",
      url: "/api/runtime/models",
      payload: { base_url: f.model.listeningOrigin + "/v1", api: "openai-completions", api_key: "fixture-key" },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().detail, /模型额度不足.*402/);
    assert.ok(!response.body.includes("fixture-key"));
  } finally {
    await f.close();
  }
});

test("malformed final protocol replies preserve failure backoff and leave the Step unfinished", async () => {
  const f = await sdkFixture();
  f.model.post("/v1/chat/completions", async (_req, reply) =>
    streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ facts: 42, summary: "invalid result" }) },
      1000,
    ),
  );
  f.store.mutate(f.graph.project.id, "", false, (g) => {
    g.project.model_failures = 2;
  });
  try {
    await assert.rejects(f.run(), (error) => {
      assert.match(String(error), /Model provider failure: final JSON does not match/);
      assert.match(String(error), /execute.*facts:.*array/s);
      f.store.release(f.graph.project.id, f.job, (error as Error).message);
      return true;
    });
    const graph = f.store.get(f.graph.project.id);
    assert.equal(graph.project.model_failures, 3);
    assert.equal(graph.project.status, "stopped");
    assert.equal(graph.steps[0].concluded_at, null);
    assert.equal(graph.usage.length, 3, "every invalid reply still consumes model tokens");
    assert.equal(f.store.runs(f.graph.project.id)[0].request_count, 3);
  } finally {
    await f.close();
  }
});

test("unlimited runtime lets a delayed model execute tools and finish without time closeout", async () => {
  const f = await sdkFixture();
  f.config.task_timeout_seconds = 0;
  f.config.closeout_seconds = 1;
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    if (++calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      streamFixture(
        reply,
        { role: "assistant", tool_calls: [toolCall("bash", { command: "echo unlimited-runtime" })] },
        1000,
      );
    } else streamFixture(reply, { role: "assistant", content: JSON.stringify({ summary: "完成", facts: [] }) }, 1000);
  });
  try {
    await f.run();
    const run = f.store.runs(f.graph.project.id)[0];
    assert.equal(calls, 2);
    assert.equal(run.external_action_possible, true);
    assert.equal(run.status, "succeeded");
  } finally {
    await f.close();
  }
});

test("unlimited shell policy preserves omitted and model-selected timeouts", async () => {
  const f = await sdkFixture();
  f.config.task_timeout_seconds = 0;
  f.config.tool_timeout_seconds = 0;
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    ++calls;
    if (calls <= 2)
      streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("bash", {
              command: `echo shell-timeout-${calls}`,
              ...(calls === 2 ? { timeout: 300 } : {}),
            }),
          ],
        },
        1000,
      );
    else streamFixture(reply, { role: "assistant", content: JSON.stringify({ summary: "完成", facts: [] }) }, 1000);
  });
  try {
    await f.run();
    const tools = readFileSync(join(f.dir, "runs", f.job.worker, "tools.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.toolName === "bash");
    assert.equal(tools.length, 2);
    assert.equal(Object.hasOwn(tools[0].args, "timeout"), false);
    assert.equal(tools[1].args.timeout, 300);
    assert.ok(tools.every((event) => !event.isError));
    assert.equal(
      f.store.get(f.graph.project.id).evidence.length,
      0,
      "tool results stay in the Run's tools.ndjson and are not Evidence by themselves",
    );
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Execute can poll a yielded Pi shell process and keeps its complete original log in the workspace", async () => {
  const f = await sdkFixture();
  let calls = 0,
    processId = "";
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    ++calls;
    if (calls === 1)
      streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("bash", {
              command: "node -e \"console.log('process-start');setTimeout(()=>console.log('process-end'),800)\"",
              yield_time_ms: 0,
            }),
          ],
        },
        1000,
      );
    else if (calls === 2) {
      const output = req.body.messages.filter((m: any) => m.role === "tool").at(-1).content;
      const running = JSON.parse(output);
      assert.equal(running.status, "running");
      assert.equal(f.store.get(f.graph.project.id).steps[0].concluded_at, null);
      assert.equal(f.store.runs(f.graph.project.id)[0].status, "running");
      processId = running.process_id;
      streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [toolCall("process", { action: "poll", process_id: processId, wait_ms: 5000, offset: 0 })],
        },
        1000,
      );
    } else {
      const output = JSON.parse(req.body.messages.filter((m: any) => m.role === "tool").at(-1).content);
      assert.equal(output.status, "exited");
      assert.match(output.output, /process-start[\s\S]*process-end/);
      streamFixture(reply, { role: "assistant", content: JSON.stringify({ summary: "进程完成", facts: [] }) }, 1000);
    }
  });
  try {
    await f.run();
    assert.equal(calls, 3);
    const graph = f.store.get(f.graph.project.id);
    assert.match(graph.steps[0].summary!, /进程原始输出/);
    assert.match(graph.steps[0].summary!, /runs\/.*processes\/.*\.log/);
    assert.ok(
      existsSync(join(f.dir, "runs", f.job.worker, "processes", processId + ".log")),
      "the complete process log stays in the project workspace",
    );
    assert.ok(
      !graph.evidence.some((e) => e.source_path?.endsWith(`${processId}.log`)),
      "shell process logs are project files, not Evidence",
    );
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Execute final submission stops unfinished commands without completing the Step", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    if (++calls === 1)
      streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("bash", {
              command: "node -e \"setTimeout(()=>console.log('late'),30000)\"",
              yield_time_ms: 0,
            }),
          ],
        },
        1000,
      );
    else streamFixture(reply, { role: "assistant", content: JSON.stringify({ summary: "提前结束", facts: [] }) }, 1000);
  });
  try {
    await assert.rejects(f.run(), (error) => {
      assert.match(String(error), /Execution incomplete/);
      f.store.release(f.graph.project.id, f.job, (error as Error).message);
      return true;
    });
    const graph = f.store.get(f.graph.project.id);
    assert.equal(graph.steps[0].concluded_at, null);
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "needs_attention");
    const logs = readdirSync(join(f.dir, "runs", f.job.worker, "processes")).filter((name) => name.endsWith(".log"));
    assert.equal(logs.length, 1, "the stopped command log stays in the project workspace");
    assert.equal(
      graph.evidence.filter((e) => e.source_path?.includes("processes")).length,
      0,
      "process logs are not automatically archived as Evidence",
    );
  } finally {
    await f.close();
  }
});

for (const revoked of [false, true])
  test(`background processes stop when ${revoked ? "asset approval is revoked" : "the project is paused"}`, async () => {
    const f = await sdkFixture();
    let calls = 0,
      processId = "";
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      if (++calls === 1)
        streamFixture(
          reply,
          {
            role: "assistant",
            tool_calls: [
              toolCall("bash", {
                command: "node -e \"setTimeout(()=>console.log('late'),30000)\"",
                yield_time_ms: 0,
              }),
            ],
          },
          1000,
        );
      else {
        processId = JSON.parse(req.body.messages.filter((m: any) => m.role === "tool").at(-1).content).process_id;
        if (revoked) f.store.revokeAssets(f.graph.project.id, ["a001"]);
        else f.store.status(f.graph.project.id, "stopped");
        streamFixture(
          reply,
          {
            role: "assistant",
            tool_calls: [toolCall("process", { action: "poll", process_id: processId, wait_ms: 10000 })],
          },
          1000,
        );
      }
    });
    try {
      await assert.rejects(f.run());
      const metadata = JSON.parse(
        readFileSync(join(f.dir, "runs", f.job.worker, "processes", `${processId}.json`), "utf8"),
      );
      assert.equal(metadata.status, "stopped");
      assert.ok(metadata.finished_at);
      const step = f.store.get(f.graph.project.id).steps[0];
      if (revoked)
        assert.equal(step.discarded, true); // Existing revocation retires the Step.
      else assert.equal(step.concluded_at, null);
      assert.notEqual(f.store.runs(f.graph.project.id)[0].status, "succeeded");
    } finally {
      await f.close();
    }
  });

test("wall-clock closeout blocks queued shell commands without requiring context pressure", async () => {
  const f = await sdkFixture();
  f.config.task_timeout_seconds = 6;
  f.config.closeout_seconds = 2;
  f.config.model.context_window = 128000;
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    if (++calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 4200));
      streamFixture(
        reply,
        { role: "assistant", tool_calls: [toolCall("bash", { command: "echo must-not-execute" })] },
        1000,
      );
    } else
      streamFixture(
        reply,
        { role: "assistant", content: JSON.stringify({ summary: "从现有证据收尾", facts: [] }) },
        1000,
      );
  });
  try {
    await f.run();
    const run = f.store.runs(f.graph.project.id)[0];
    assert.equal(calls, 2);
    assert.equal(run.external_action_possible, false);
    assert.equal(run.status, "succeeded");
    assert.ok(f.store.get(f.graph.project.id).steps[0].executed_at);
    assert.equal(f.store.get(f.graph.project.id).steps[0].concluded_at, null);
  } finally {
    await f.close();
  }
});

/** 采集是 Execute 的前置条件：beforeToolCall 必须按 /traffic/status 阻止世界交互。 */
async function captureGate(status: Record<string, unknown>) {
  const f = await sdkFixture(),
    previous = process.env.TESSERA_CAPTURE_REQUIRED;
  process.env.TESSERA_CAPTURE_REQUIRED = "1";
  f.store.traffic.setStatus(f.graph.project.id, {
    state: "active",
    guard: true,
    blocked: 0,
    dropped: 0,
    ...status,
  } as any);
  const transcripts: string[] = [];
  let calls = 0;
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1)
      streamFixture(
        reply,
        { role: "assistant", tool_calls: [toolCall("bash", { command: "echo capture-gate" })] },
        1000,
      );
    else {
      transcripts.push(JSON.stringify(req.body.messages));
      streamFixture(
        reply,
        { role: "assistant", content: JSON.stringify({ summary: "capture gate", facts: [] }) },
        1000,
      );
    }
  });
  let externalAction = false;
  try {
    await f.run();
    externalAction = !!f.store.runs(f.graph.project.id)[0]?.external_action_possible;
  } finally {
    if (previous === undefined) delete process.env.TESSERA_CAPTURE_REQUIRED;
    else process.env.TESSERA_CAPTURE_REQUIRED = previous;
    await f.close();
  }
  // 只看工具真正返回给模型的内容：拦下时是理由，放行时是命令输出。
  const messages = transcripts.flatMap((text) => JSON.parse(text) as Array<{ role: string; content: unknown }>);
  const outputs = messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  return { outputs: outputs.join("\n"), externalAction };
}

test("Execute continues shell commands when capture is unavailable, incomplete or stale", async () => {
  for (const status of [
    { state: "unavailable", guard: false },
    { state: "active", guard: true, dropped: 1 },
    { state: "active", guard: false, last_seen: "2000-01-01T00:00:00Z" },
  ]) {
    const { outputs, externalAction } = await captureGate(status);
    assert.match(outputs, /capture-gate/, JSON.stringify(status));
    assert.doesNotMatch(outputs, /capture is unavailable or incomplete/);
    assert.equal(externalAction, true, "capture health cannot be an execution permission gate");
  }
});

test("Execute still runs shell commands when capture is active and complete", async () => {
  const { outputs, externalAction } = await captureGate({});
  assert.match(outputs, /capture-gate/, `capture gate blocked a healthy run: ${outputs}`);
  assert.doesNotMatch(outputs, /capture is unavailable or incomplete/);
  assert.equal(externalAction, true, "放行后应上报外部动作");
});

test("format repair uses only existing evidence and completes without repeating exploration", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1) streamFixture(reply, { role: "assistant", content: '{"summary":"不完整结果"' }, 1000);
    else {
      const names = req.body.tools.map((tool: any) => tool.function.name);
      assert.ok(names.includes("bash"), "repair retains declarations, beforeToolCall enforces read-only behavior");
      const correction = req.body.messages.filter((m: any) => m.role === "user").at(-1).content;
      assert.match(JSON.stringify(correction), /incomplete or ambiguous envelope/);
      assert.match(JSON.stringify(correction), /JSON Schema/);
      assert.match(JSON.stringify(correction), /additionalProperties/);
      streamFixture(
        reply,
        { role: "assistant", content: JSON.stringify({ summary: "已修复结果序列化", facts: [] }) },
        1000,
      );
    }
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    assert.equal(f.store.runs(f.graph.project.id)[0].external_action_possible, false);
    assert.equal(f.store.runs(f.graph.project.id)[0].request_count, 2);
    assert.equal(f.store.get(f.graph.project.id).steps[0].summary, "已修复结果序列化");
    const captures = readFileSync(join(f.dir, "runs", f.job.worker, "model-responses.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const parses = captures.filter((e) => e.type === "parse_input");
    assert.equal(parses.length, 2);
    assert.deepEqual(
      parses.map((e) => e.request_id),
      ["request_1", "request_2"],
    );
    assert.equal(parses[0].data.text, '{"summary":"不完整结果"');
    assert.equal(parses[1].data.text, JSON.stringify({ summary: "已修复结果序列化", facts: [] }));
    for (const parse of parses) {
      const message = captures.find((e) => e.type === "sdk_message" && e.request_id === parse.request_id);
      assert.equal(message.data.content.find((c: any) => c.type === "text").text, parse.data.text);
    }
  } finally {
    await f.close();
  }
});

for (const kind of ["execute", "decide"] as const)
  test(`GLM ${kind} repair uses an atomic completion and retains tool permission checks`, async () => {
    const f = await sdkFixture(kind);
    let calls = 0;
    f.config.model.id = "glm-5";
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      if (++calls === 1) {
        assert.equal(req.body.stream, true);
        assert.equal(req.body.response_format, undefined);
        return streamFixture(
          reply,
          { role: "assistant", content: 'facts\\\":[{\\\"description\\\":\\\"broken\\\"}]}' },
          1000,
        );
      }
      assert.equal(req.body.stream, false);
      assert.deepEqual(req.body.response_format, { type: "json_object" });
      const content =
        calls === 2
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "denied",
                  type: "function",
                  function: {
                    name: kind === "execute" ? "write" : "query_graph",
                    arguments: JSON.stringify(
                      kind === "execute" ? { path: join(f.dir, "forbidden.txt"), content: "must not write" } : {},
                    ),
                  },
                },
                {
                  id: "read",
                  type: "function",
                  function: { name: "read_graph", arguments: JSON.stringify({ id: "origin" }) },
                },
              ],
            }
          : {
              role: "assistant",
              content: JSON.stringify(
                kind === "execute"
                  ? { summary: "原子响应修复完成", facts: [] }
                  : { steps: [{ from: ["origin"], description: "根据已有记录继续判断" }] },
              ),
            };
      return {
        id: "atomic",
        object: "chat.completion",
        created: 1,
        model: "glm-5",
        choices: [{ index: 0, message: content, finish_reason: calls === 2 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 },
      };
    });
    try {
      await f.run();
      assert.equal(calls, 3);
      assert.equal(existsSync(join(f.dir, "forbidden.txt")), false);
      const run = f.store.runs(f.graph.project.id)[0];
      assert.equal(run.status, "succeeded");
      assert.equal(run.external_action_possible, false);
      assert.equal(run.request_count, 3);
      const captures = readFileSync(join(f.dir, "runs", f.job.worker, "model-responses.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.deepEqual(
        captures.filter((e) => e.type === "request_start").map((e) => e.data.transport),
        ["provider_stream", "completion_json_as_sse", "completion_json_as_sse"],
      );
      assert.ok(
        captures
          .filter((e) => e.type === "request_payload")
          .slice(1)
          .every((e) => e.data.response_format === "json_object"),
      );
      const nativeFinal = captures.filter((e) => e.type === "native_completion").at(-1);
      const parsedFinal = captures.filter((e) => e.type === "parse_input").at(-1);
      assert.equal(nativeFinal.request_id, parsedFinal.request_id);
      assert.equal(nativeFinal.data.choices[0].message.content, parsedFinal.data.text);
    } finally {
      await f.close();
    }
  });

for (const failure of ["length", "schema", "quota"] as const)
  test(`GLM atomic repair still rejects ${failure} without completing the Step`, async () => {
    const f = await sdkFixture();
    let calls = 0;
    f.config.model.id = "glm-5";
    f.model.post("/v1/chat/completions", async (req: any, reply) => {
      if (++calls === 1) return streamFixture(reply, { role: "assistant", content: "narrative instead of JSON" }, 1000);
      assert.equal(req.body.stream, false);
      if (failure === "quota") return reply.code(402).send({ error: { message: "quota exhausted fixture-key" } });
      return {
        id: "atomic-invalid",
        object: "chat.completion",
        created: 1,
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ summary: "must remain unfinished", facts: failure === "schema" ? 42 : [] }),
            },
            finish_reason: failure === "length" ? "length" : "stop",
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 },
      };
    });
    try {
      await assert.rejects(f.run(), (e) => {
        const message = String(e);
        assert.ok(!message.includes("fixture-key"));
        assert.match(
          message,
          failure === "length"
            ? /Truncated final response/
            : failure === "schema"
              ? /facts:.*array/s
              : /Model provider failure: 402/,
        );
        return true;
      });
      // Two repair rounds by default; a non-retryable provider error stops at the first one.
      assert.equal(calls, failure === "quota" ? 2 : 3);
      assert.equal(f.store.get(f.graph.project.id).steps[0].concluded_at, null);
    } finally {
      await f.close();
    }
  });

test("provider failure during format repair preserves the actual cause and redacts the key", async () => {
  const f = await sdkFixture();
  let calls = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    if (++calls === 1)
      streamFixture(reply, { role: "assistant", content: '<think>done</think>\n.json\n{"facts":[]}\n```' }, 1000);
    else return reply.code(402).send({ error: { message: "quota exhausted fixture-key" } });
  });
  try {
    await assert.rejects(f.run(), (error) => {
      assert.match(String(error), /Model provider failure: 402/);
      assert.ok(!String(error).includes("fixture-key"));
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(f.store.get(f.graph.project.id).steps[0].concluded_at, null);
  } finally {
    await f.close();
  }
});

test("Decide repairs the observed unmatched fence using its exact planning contract", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", async (req: any, reply) => {
    if (++calls === 1)
      streamFixture(
        reply,
        { role: "assistant", content: '<think>Example {"wrong":true}</think>\n.json\n{"steps":[]}\n```' },
        1000,
      );
    else {
      const correction = JSON.stringify(req.body.messages.filter((m: any) => m.role === "user").at(-1).content);
      assert.match(correction, /任务 decide 的结果序列化失败/);
      assert.match(correction, /incomplete or ambiguous envelope/);
      assert.match(correction, /hint_ids/);
      assert.ok(req.body.tools.some((t: any) => t.function.name === "query_graph"));
      streamFixture(
        reply,
        { role: "assistant", content: JSON.stringify({ steps: [{ from: ["origin"], description: "整理原始证据" }] }) },
        1000,
      );
    }
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    assert.equal(f.store.get(f.graph.project.id).steps.length, 1);
    assert.equal(f.store.get(f.graph.project.id).steps[0].description, "整理原始证据");
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("Decide repair keeps graph reads but rejects tool submissions", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    calls++;
    if (calls === 1) return streamFixture(reply, { role: "assistant", content: "不是结果信封" }, 1000);
    if (calls === 2)
      return streamFixture(
        reply,
        {
          role: "assistant",
          tool_calls: [
            toolCall("read_graph", {}),
            toolCall("submit_decisions", { steps: [{ from: ["origin"], description: "工具提交不应生效" }] }, 1),
          ],
        },
        1000,
      );
    const toolMessages = req.body.messages
      .filter((message: any) => message.role === "tool")
      .map((message: any) => String(message.content));
    assert.ok(
      toolMessages.some((content: string) => content.includes("origin")),
      "repair reads the current graph",
    );
    assert.ok(
      toolMessages.some((content: string) => content.includes("Repair accepts only existing-material reads")),
      "repair rejects a tool submission",
    );
    assert.ok(
      !toolMessages.some((content: string) => content.includes("Closeout permits")),
      "Decide repair is not an Execute closeout",
    );
    streamFixture(
      reply,
      { role: "assistant", content: JSON.stringify({ steps: [{ from: ["origin"], description: "修复后计划" }] }) },
      1000,
    );
  });
  try {
    await f.run();
    assert.equal(calls, 3);
    const steps = f.store.get(f.graph.project.id).steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].description, "修复后计划");
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("a missing read_graph record is a tool error, not a JSON result the model can copy", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", (req: any, reply) => {
    calls++;
    if (calls === 1)
      return streamFixture(reply, { role: "assistant", tool_calls: [toolCall("read_graph", { id: "f1" })] });
    const toolMessages = req.body.messages
      .filter((message: any) => message.role === "tool")
      .map((message: any) => String(message.content));
    const missing = toolMessages.find((content: string) => content.includes("Record not found"));
    assert.ok(missing, "the missing record reaches the model as a tool error");
    assert.match(missing!, /query_graph/);
    assert.ok(
      !missing!.trim().startsWith('{"error"'),
      "a tool error is never a success-shaped JSON object with an error key",
    );
    streamFixture(reply, {
      role: "assistant",
      content: JSON.stringify({ steps: [{ from: ["origin"], description: "重新规划" }] }),
    });
  });
  try {
    await f.run();
    assert.equal(calls, 2);
    const steps = f.store.get(f.graph.project.id).steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].description, "重新规划");
    assert.equal(f.store.runs(f.graph.project.id)[0].status, "succeeded");
  } finally {
    await f.close();
  }
});

test("a security gateway interception fails the Run without a JSON repair", async () => {
  const f = await sdkFixture("decide");
  let calls = 0;
  f.model.post("/v1/chat/completions", (_req: any, reply) => {
    calls++;
    streamFixture(reply, {
      role: "assistant",
      content:
        '⚠️ [此消息为llm-guard回复] 回答内容存在风险，已被安全网关拦截，拦截类型为"违反社会主义核心价值观的内容"。',
    });
  });
  try {
    await assert.rejects(f.run(), /Model provider failure: 安全网关拦截/);
    assert.equal(calls, 1, "a blocked response must not be sent through result repair");
  } finally {
    await f.close();
  }
});

test("forced worker termination retains an in-flight request with explicitly unknown usage", async () => {
  const f = await sdkFixture();
  let requests = 0;
  f.model.post("/v1/chat/completions", async (_req, reply) => {
    requests++;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write(
      `data: ${JSON.stringify({ id: "pending", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "尚未结束的响应" }, finish_reason: null }] })}\n\n`,
    );
  });
  await f.model.listen({ host: "127.0.0.1", port: 0 });
  f.config.model.base_url = f.model.listeningOrigin + "/v1";
  const child = spawn(process.execPath, ["--import", "tsx", "packages/runner/src/main.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TESSERA_JOB: Buffer.from(JSON.stringify(f.job)).toString("base64"),
      TESSERA_RUN_CONFIG: Buffer.from(JSON.stringify(f.config)).toString("base64"),
      TESSERA_WORKER_TOKEN: testWorkerToken,
      TESSERA_WORKSPACE: f.dir,
    },
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + String(data)).slice(-2000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 8000;
    while (requests === 0 || f.store.runs(f.graph.project.id)[0].request_count === 0) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Worker exited before request: ${diagnostics}`);
      if (Date.now() > deadline) throw new Error(`Worker request did not start: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("Worker did not terminate")), 5000);
      }),
    ]);
    clearTimeout(exitTimer);
    f.store.release(f.graph.project.id, f.job, "Worker process terminated");
    const run = f.store.runs(f.graph.project.id)[0];
    assert.equal(run.request_count, 1);
    assert.equal(run.unknown_request_count, 1);
    assert.equal(run.input, null);
    assert.equal(run.output, null);
    assert.equal(f.store.get(f.graph.project.id).usage.length, 1);
    assert.ok(existsSync(join(f.dir, "runs", f.job.worker, "usage.ndjson")));
  } finally {
    clearTimeout(exitTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    f.model.server.closeAllConnections();
    await f.close();
  }
});
