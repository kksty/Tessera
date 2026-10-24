import { test } from "node:test";
import assert from "node:assert/strict";
import { guardMessage, modelIssue, redactModelError } from "../../packages/protocol/src/model-errors.js";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("model errors distinguish permanent configuration failures from recoverable outages", () => {
  for (const [raw, kind, retryable] of [
    ['402: {"type":"insufficient_balance_error","message":"用量上限"}', "quota", false],
    ['429: {"error":{"type":"insufficient_quota","message":"quota exhausted"}}', "quota", false],
    ["401: invalid_api_key", "auth", false],
    ["403: Forbidden", "auth", false],
    ["404: model_not_found", "configuration", false],
    ["400: maximum context length exceeded", "context", false],
    ["429: rate limit exceeded", "rate_limit", true],
    ["503: overloaded", "unavailable", true],
    ["fetch failed", "unavailable", true],
    ["empty provider response", "response", true],
  ] as const) {
    const issue = modelIssue("Model provider failure: " + raw)!;
    assert.equal(issue.kind, kind, raw);
    assert.equal(issue.retryable, retryable, raw);
  }
  assert.equal(modelIssue("Step lease lost"), null);
  assert.equal(
    redactModelError('Bearer secret-token api_key="secret" echoed secret', ["secret"]),
    'Bearer [redacted] api_key="[redacted]" echoed [redacted]',
  );
});

test("a content gateway interception is detected without flagging ordinary WAF discussion", () => {
  const blocked =
    '⚠️ [此消息为llm-guard回复] 回答内容存在风险，已被安全网关拦截，拦截类型为"违反社会主义核心价值观的内容"。';
  assert.match(guardMessage(blocked)!, /已被安全网关拦截/);
  const issue = modelIssue("Model provider failure: " + blocked)!;
  assert.equal(issue.kind, "guard");
  assert.equal(issue.retryable, true);
  assert.match(issue.title, /安全网关/);
  // A report that merely discusses a WAF or a security gateway is not a block.
  assert.equal(guardMessage("目标部署了安全网关，未发现绕过方式。"), undefined);
  assert.equal(guardMessage("llm-guard is the product name of the target WAF."), undefined);
  assert.match(guardMessage("⚠️ 回答已被安全网关拦截")!, /已被安全网关拦截/);
  // A valid JSON result may quote the same phrase as evidence; it is data, not a block.
  assert.equal(
    guardMessage(JSON.stringify({ facts: [{ description: "证据显示目标返回：已被安全网关拦截" }] })),
    undefined,
  );
});

test("transient model failures back off project-wide and stop after three failures", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(
      createProjectSchema.parse({ title: "Outage", origin: "https://example.test", goal: "Assess" }),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = store.claim(graph.project.id, `planner-${attempt}`, 0)!;
      assert.equal(job.kind, "decide");
      store.release(graph.project.id, job, "Model provider failure: 503: overloaded");
      const g = store.get(graph.project.id);
      assert.equal(g.project.model_failures, attempt);
      if (attempt < 3) {
        assert.equal(store.claim(graph.project.id, "immediate-retry", 0), null);
        store.mutate(graph.project.id, "fixture.clock", false, (g) => {
          g.project.model_retry_at = undefined;
          g.project.decide_retry_at = undefined;
        });
      } else assert.equal(g.project.status, "stopped");
    }
    store.status(graph.project.id, "active");
    assert.equal(store.get(graph.project.id).project.model_failures, 0);
    assert.equal(store.claim(graph.project.id, "after-recovery", 0)?.kind, "decide");
  } finally {
    store.close();
  }
});
