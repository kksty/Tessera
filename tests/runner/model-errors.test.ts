import { test } from "node:test";
import assert from "node:assert/strict";
import { modelIssue, redactModelError } from "../../packages/protocol/src/model-errors.js";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("model errors distinguish permanent configuration failures from recoverable outages", () => {
  for (const [raw, kind, retryable] of [
    ['402: {"type":"insufficient_balance_error","message":"用量上限"}', "quota", false],
    ['429: {"error":{"type":"insufficient_quota","message":"quota exhausted"}}', "quota", false],
    ["401: invalid_api_key", "auth", false], ["403: Forbidden", "auth", false],
    ["404: model_not_found", "configuration", false],
    ["400: maximum context length exceeded", "context", false],
    ["429: rate limit exceeded", "rate_limit", true], ["503: overloaded", "unavailable", true],
    ["fetch failed", "unavailable", true], ["empty provider response", "response", true],
  ] as const) {
    const issue = modelIssue("Model provider failure: " + raw)!;
    assert.equal(issue.kind, kind, raw); assert.equal(issue.retryable, retryable, raw);
  }
  assert.equal(modelIssue("Step lease lost"), null);
  assert.equal(redactModelError('Bearer secret-token api_key="secret" echoed secret', ["secret"]), 'Bearer [redacted] api_key="[redacted]" echoed [redacted]');
});

test("transient model failures back off project-wide and stop after three failures", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Outage", origin: "https://example.test", goal: "Assess" }));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = store.claim(graph.project.id, `planner-${attempt}`, 0)!;
      assert.equal(job.kind, "decide");
      store.release(graph.project.id, job, "Model provider failure: 503: overloaded");
      const g = store.get(graph.project.id);
      assert.equal(g.project.model_failures, attempt);
      if (attempt < 3) {
        assert.equal(store.claim(graph.project.id, "immediate-retry", 0), null);
        store.mutate(graph.project.id, "fixture.clock", false, g => {
          g.project.model_retry_at = undefined; g.project.decide_retry_at = undefined;
        });
      } else assert.equal(g.project.status, "stopped");
    }
    store.status(graph.project.id, "active");
    assert.equal(store.get(graph.project.id).project.model_failures, 0);
    assert.equal(store.claim(graph.project.id, "after-recovery", 0)?.kind, "decide");
  } finally { store.close(); }
});
