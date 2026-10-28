/** Real provider acceptance; isolates SQLite/workspace and never contacts a target. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuredModel } from "../../packages/models/src/runtime.js";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { runJob } from "../../packages/runner/src/run.js";
import { observeModel, type RequestCounters } from "../../packages/runner/src/model-observer.js";
import { buildApp, testWorkerToken } from "../../tests/helpers/server.js";
import { acceptanceModel, acceptanceRuntime } from "./acceptance-config.js";

const root = resolve(import.meta.dirname, "../..");
const runtime = acceptanceRuntime();
const cfg = acceptanceModel();
assert.ok(cfg.id && (cfg.base_url || cfg.provider) && cfg.api_key, "Missing model configuration");
assert.equal(cfg.api, "openai-completions", "This acceptance checks OpenAI-compatible event alignment");
const dir = mkdtempSync(join(tmpdir(), "tessera-observation-"));
const out = join(root, "test-results", `model-observation-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const store = new Store(join(dir, "test.db"));
const app = buildApp(store, runtime, join(dir, "no-web"));
const rows = (directory: string): any[] =>
  readFileSync(join(directory, "model-responses.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

function align(records: any[]) {
  const ends = records.filter((r) => r.type === "request_end");
  assert.ok(ends.length > 0);
  return ends.map((end) => {
    const request = records.filter((r) => r.request_id === end.request_id);
    const providerEvents = request.filter((r) => r.type === "provider_event");
    const providerText = providerEvents
      .flatMap((r) => r.data.choices ?? [])
      .filter((c) => c.index === 0)
      .map((c) => c.delta?.content ?? "")
      .join("");
    const sdk = request.find((r) => r.type === "sdk_message");
    const sdkText = sdk.data.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    assert.equal(providerText, sdkText);
    for (const parse of request.filter((r) => r.type === "parse_input")) assert.equal(parse.data.text, sdkText);
    const usage = providerEvents.map((r) => r.data.usage).findLast((u) => u);
    assert.ok(usage);
    assert.equal(end.data.counters.input, usage.prompt_tokens);
    assert.equal(end.data.counters.output, usage.completion_tokens);
    assert.equal(
      end.data.counters.cache_read,
      usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? null,
    );
    return {
      request_id: end.request_id,
      provider_events: providerEvents.length,
      public_chars: sdkText.length,
      aligned: true,
      stop_reason: end.data.stop_reason,
      parse_inputs: request.filter((r) => r.type === "parse_input").length,
      counters: end.data.counters,
      provider_usage: usage,
    };
  });
}

try {
  const { runtime: models, model } = await configuredModel({ ...cfg, max_output_tokens: 512 });
  const probeDir = join(dir, "probe");
  mkdirSync(probeDir);
  const context = {
    messages: [
      {
        role: "user" as const,
        content: '只输出 JSON 对象：{"ok":true}。\n' + "这是相同请求的缓存字段对照，内容保持固定。".repeat(90),
        timestamp: 1,
      },
    ],
  };
  const counters: RequestCounters[] = [];
  const observer = observeModel((_model, _context, options) => models.streamSimple(model, context, options), {
    directory: probeDir,
    runId: "repeated-probe",
    secrets: [cfg.api_key],
    start: () => {},
    complete: (_id, usage) => counters.push(usage),
    failure: () => {
      throw new Error("Capture failed");
    },
  });
  // Two identical serialized requests; stream consumption remains the caller's responsibility.
  for (let i = 0; i < 2; i++) {
    // The probe callback owns the plain Context and passes it through ModelRuntime's
    // normalizer; this unused argument never reaches a provider as a raw transcript.
    const stream = await observer.stream(model, context as Parameters<typeof observer.stream>[1], {
      maxTokens: 128,
      signal: AbortSignal.timeout(120000),
      maxRetries: 0,
    });
    for await (const _event of stream) {
      /* Drain exactly once, by the consumer. */
    }
    const message = await stream.result();
    assert.notEqual(message.stopReason, "error");
  }
  const probes = align(rows(probeDir));
  assert.equal(counters.length, 2);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const graph = store.create(
    createProjectSchema.parse({
      title: "模型响应链路验收",
      origin: "https://example.test",
      goal: "验证模型输出与程序解析一致；无需访问任何目标",
    }),
  );
  store.hint(
    graph.project.id,
    "这是纯协议验收。无需调用工具或创建 Step，直接以 origin 为来源提交 complete，说明协议验证完成。",
  );
  const job = store.claim(graph.project.id, "observation-worker", 0)!;
  await runJob(
    job,
    { ...runtime.value, server: app.listeningOrigin, task_timeout_seconds: 120, closeout_seconds: 10, model: cfg },
    new ApiClient(app.listeningOrigin, testWorkerToken),
    dir,
  );
  assert.equal(store.get(graph.project.id).project.status, "completed");
  const runnerRecords = rows(join(dir, "runs", job.worker));
  const runner = align(runnerRecords);
  const hasFinalText = runner.some((r) => r.parse_inputs > 0);
  const hasDecisionTool = runnerRecords.some(
    (record) =>
      record.type === "sdk_message" &&
      record.data.content.some(
        (part: { type: string; name?: string }) => part.type === "toolCall" && part.name === "submit_decisions",
      ),
  );
  assert.ok(hasFinalText || hasDecisionTool, "Record either the final JSON path or the decision tool path");
  const run = store.execution.get(graph.project.id, job.run_id!)!;
  assert.equal(run.request_count, runner.length);
  assert.equal(
    run.input,
    runner.reduce((sum, r) => sum + r.counters.input, 0),
  );
  assert.equal(
    run.cache_read,
    runner.reduce((sum, r) => sum + (r.counters.cache_read ?? 0), 0),
  );
  assert.equal(run.cost, null);
  mkdirSync(out, { recursive: true });
  const report = {
    at: new Date().toISOString(),
    sdk: "1.2.0",
    model: { id: cfg.id, base_url: cfg.base_url, api: cfg.api, context_window: cfg.context_window },
    probes,
    runner,
    run: {
      request_count: run.request_count,
      input: run.input,
      input_uncached: run.input_uncached,
      cache_read: run.cache_read,
      cache_write: run.cache_write ?? null,
      output: run.output,
      cost: run.cost,
      unknown_breakdown_request_count: run.unknown_breakdown_request_count,
    },
    project_completed: true,
    verdict: "passed",
  };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(cfg.api_key));
  writeFileSync(join(out, "report.json"), serialized);
  // Persist only sanitized public captures; never copy auth.json or runtime.json.
  for (const [name, records] of [
    ["probe", rows(probeDir)],
    ["runner", runnerRecords],
  ] as const)
    writeFileSync(join(out, `${name}-responses.ndjson`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(
    JSON.stringify({ verdict: "passed", report: join(out, "report.json"), probes, runner, run: report.run }, null, 2) +
      "\n",
  );
} finally {
  await app.close();
  store.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir())) && existsSync(dir));
  rmSync(dir, { recursive: true, force: true });
}
