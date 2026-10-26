import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionEvents,
  finalCompletionFetch,
  useAtomicResult,
  withResultFormat,
} from "../../packages/runner/src/result-format.js";

test("GLM/qwen final transport is scoped to validated models and final serialization", async () => {
  for (const id of ["glm-5", "z-ai/glm-5", "qwen3.8-27b", "qwen3-coder-plus", "Qwen2.5-72B"])
    assert.equal(useAtomicResult("openai-completions", id), true);
  for (const [api, id] of [
    ["anthropic-messages", "glm-5"],
    ["openai-responses", "glm-5"],
    ["openai-completions", "fixture"],
    ["openai-completions", "deepseek-chat"],
    ["openai-completions", "glm-4.7"],
    ["openai-completions", "not-glm-5"],
  ])
    assert.equal(useAtomicResult(api, id), false);
  let serializing = false;
  const payload = {
    tools: [{ function: { name: "read_graph" } }],
    thinking: { type: "enabled" },
    messages: [{ role: "user", content: "original" }],
  };
  const context = { messages: [] } as any;
  const signal = AbortSignal.timeout(1000),
    sentinel = {};
  const originalOptions = { signal };
  const stream = withResultFormat(
    async (_model, actualContext, options) => {
      assert.equal(context, actualContext);
      assert.equal(options?.signal, signal);
      if (!serializing) {
        assert.equal(options, originalOptions);
        return sentinel as any;
      }
      const actual = (await options?.onPayload?.(payload, _model)) as any;
      assert.equal(actual.response_format.type, "json_object");
      assert.equal(actual.tools, payload.tools);
      assert.equal(actual.thinking, payload.thinking);
      assert.equal(actual.messages, payload.messages);
      assert.equal((payload as any).response_format, undefined);
      return sentinel as any;
    },
    () => serializing,
  );
  assert.equal(await stream({ id: "glm-5", api: "openai-completions" } as any, context, originalOptions), sentinel);
  serializing = true;
  assert.equal(await stream({ id: "glm-5", api: "openai-completions" } as any, context, originalOptions), sentinel);
});

test("atomic completion transport preserves text, thinking fields, usage, tool arguments and cancellation", async () => {
  const args = '{"id":"e001","literal":"\\\"[]{}"}';
  const completion = {
    id: "reply",
    created: 1,
    model: "glm-5",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Exact \\ content {} [not a JSON result]",
          reasoning_content: "private",
          tool_calls: [{ id: "call", type: "function", function: { name: "read_evidence", arguments: args } }],
        },
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 40, total_tokens: 361 },
  };
  const signal = AbortSignal.timeout(1000);
  const payload = {
    model: "glm-5",
    stream: true,
    response_format: { type: "json_object" },
    tools: [{ name: "original" }],
    thinking: { type: "enabled" },
  };
  const fn = finalCompletionFetch(async (input) => {
    const request = input as Request;
    const actual = (await request.json()) as any;
    assert.deepEqual(actual, { ...payload, stream: false });
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
    assert.equal(request.signal.aborted, false);
    return new Response(JSON.stringify(completion), {
      headers: { "content-type": "application/json", "content-length": "999", "content-encoding": "gzip" },
    });
  });
  const response = await fn("http://fixture.invalid/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { authorization: "Bearer fixture-key" },
    body: JSON.stringify({ ...payload, stream_options: { include_usage: true } }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("content-length"), null);
  const event = JSON.parse((await response.text()).split("\n")[0].slice(6));
  assert.equal(event.choices[0].delta.content, completion.choices[0].message.content);
  assert.equal(event.choices[0].delta.reasoning_content, "private");
  assert.equal(event.choices[0].delta.tool_calls[0].function.arguments, args);
  assert.equal(event.choices[0].delta.tool_calls[0].index, 0);
  assert.deepEqual(event.usage, completion.usage);
  assert.equal(payload.stream, true);
  assert.throws(() => completionEvents({ choices: [] }), /invalid non-streaming/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    finalCompletionFetch(fetch)("http://fixture.invalid/v1/chat/completions", {
      method: "POST",
      signal: aborted.signal,
      body: "{}",
    }),
  );
});

test("atomic transport passes through provider failures and unrelated endpoints", async () => {
  const failure = new Response('{"error":{"message":"quota exhausted"}}', { status: 402 });
  const fn = finalCompletionFetch(async () => failure);
  assert.equal(await fn("http://fixture.invalid/v1/chat/completions", { method: "POST", body: "{}" }), failure);
  assert.equal(await fn("http://fixture.invalid/v1/models"), failure);
});

test("atomic completion observes cancellation while waiting for the provider", async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const fn = finalCompletionFetch(
    async (input) =>
      new Promise((_resolve, reject) => {
        const signal = (input as Request).signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        ready();
      }),
  );
  const waiting = fn("http://fixture.invalid/v1/chat/completions", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  await started;
  controller.abort(new Error("original task timeout"));
  await assert.rejects(waiting, /original task timeout/);
});

test("serialization preserves payload hook replacements, other options and unsupported models", async () => {
  const replacement = { messages: ["replacement"], temperature: 0.4 };
  let calls = 0;
  const options = {
    onPayload: () => {
      calls++;
      return replacement;
    },
  };
  const fn = withResultFormat(
    async (model, _context, supplied) => {
      if (model.id === "deepseek-chat") assert.equal(supplied, options);
      const body = (await supplied?.onPayload?.({}, model)) as any;
      if (model.id === "glm-5") {
        assert.equal(body.messages, replacement.messages);
        assert.equal(body.temperature, 0.4);
        assert.deepEqual(body.response_format, { type: "json_object" });
      } else assert.equal(body, replacement);
      return {} as any;
    },
    () => true,
  );
  await fn({ id: "glm-5", api: "openai-completions" } as any, {} as any, options);
  await fn({ id: "deepseek-chat", api: "openai-completions" } as any, {} as any, options);
  assert.equal(calls, 2);
  assert.equal((replacement as any).response_format, undefined);
});
