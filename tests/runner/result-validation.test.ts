import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, type DispatchConfig, type Job } from "../../packages/protocol/src/index.js";
import {
  ModelReportedError,
  repairFinalResult,
  validateFinalResult,
} from "../../packages/runner/src/result-validation.js";

function fixture() {
  const store = new Store(":memory:");
  const graph = store.create(
    createProjectSchema.parse({ title: "Result contract", origin: "https://example.test", goal: "Plan" }),
  );
  const job = store.claim(graph.project.id, "planner", 0) as Job;
  const validate = (text: string | undefined) =>
    validateFinalResult(job, store.get(graph.project.id), async () => store.get(graph.project.id), text);
  return { store, graph, job, validate };
}

test("a model error envelope is reported separately from a schema violation", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.validate(JSON.stringify({ error: "Fact f1 not found", details: "read_graph returned Record not found" })),
      (error: unknown) =>
        error instanceof ModelReportedError &&
        /模型返回了错误说明而不是任务结果/.test(error.message) &&
        /Fact f1 not found/.test(error.message) &&
        /Record not found/.test(error.message),
    );
    // A payload that carries an actual result is validated normally, even if the
    // model also mentions an error field.
    await assert.rejects(f.validate(JSON.stringify({ error: "note", steps: "not-an-array" })), /steps/);
  } finally {
    f.store.close();
  }
});

test("a repair that answers with an error envelope gets one targeted serialization retry", async () => {
  const f = fixture();
  try {
    let text = "not JSON";
    const repairs: string[] = [];
    const payload = await repairFinalResult({
      job: f.job,
      config: { result_repairs: 1 } as DispatchConfig,
      deadline: Infinity,
      key: "",
      text: () => text,
      stopReason: () => "stop",
      leaseError: () => undefined,
      trace: () => {},
      diagnose: () => {},
      validate: f.validate,
      repair: async (detail) => {
        repairs.push(detail);
        text =
          repairs.length === 1
            ? JSON.stringify({ error: "Fact f1 not found", details: "Record not found" })
            : JSON.stringify({ steps: [{ from: ["origin"], description: "修复后的计划" }] });
      },
    });
    assert.equal((payload.steps as unknown[]).length, 1);
    assert.equal(repairs.length, 2);
    assert.match(repairs[0], /no valid JSON result/);
    assert.match(repairs[1], /错误说明/);
  } finally {
    f.store.close();
  }
});

test("an initial error envelope stays within the configured repair budget", async () => {
  const f = fixture();
  try {
    let text = JSON.stringify({ error: "blocked", details: "no material" });
    const repairs: string[] = [];
    const payload = await repairFinalResult({
      job: f.job,
      config: { result_repairs: 1 } as DispatchConfig,
      deadline: Infinity,
      key: "",
      text: () => text,
      stopReason: () => "stop",
      leaseError: () => undefined,
      trace: () => {},
      diagnose: () => {},
      validate: f.validate,
      repair: async (detail) => {
        repairs.push(detail);
        text = JSON.stringify({ steps: [{ from: ["origin"], description: "修复后的计划" }] });
      },
    });
    assert.equal(repairs.length, 1);
    assert.equal((payload.steps as unknown[]).length, 1);
  } finally {
    f.store.close();
  }
});

test("repairs disabled means an error envelope fails immediately with the model's message", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      repairFinalResult({
        job: f.job,
        config: { result_repairs: 0 } as DispatchConfig,
        deadline: Infinity,
        key: "",
        text: () => JSON.stringify({ error: "quota exhausted", details: "upstream" }),
        stopReason: () => "stop",
        leaseError: () => undefined,
        trace: () => {},
        diagnose: () => {},
        validate: f.validate,
        repair: async () => assert.fail("repair must not run when disabled"),
      }),
      /Model provider failure: .*quota exhausted/,
    );
  } finally {
    f.store.close();
  }
});

test("a security gateway interception fails without spending a result repair", async () => {
  const f = fixture();
  try {
    let repairs = 0;
    await assert.rejects(
      repairFinalResult({
        job: f.job,
        config: { result_repairs: 1 } as DispatchConfig,
        deadline: Infinity,
        key: "",
        text: () =>
          '⚠️ [此消息为llm-guard回复] 回答内容存在风险，已被安全网关拦截，拦截类型为"违反社会主义核心价值观的内容"。',
        stopReason: () => "stop",
        leaseError: () => undefined,
        trace: () => {},
        diagnose: () => {},
        validate: f.validate,
        repair: async () => {
          repairs++;
        },
      }),
      /Model provider failure: 安全网关拦截/,
    );
    assert.equal(repairs, 0, "a blocked gateway response is not fixable by another JSON answer");
  } finally {
    f.store.close();
  }
});
