import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedPaths,
  changeSummary,
  reviewModelEnabled,
  runtimeFieldErrors,
} from "../../apps/web/src/settings-form.js";
import type { RuntimeConfig } from "../../apps/web/src/workspace.js";

const base = (): RuntimeConfig => ({
  max_workers: 4,
  max_project_workers: 4,
  max_project_review_workers: 1,
  interval_ms: 1000,
  debounce_ms: 2000,
  task_timeout_seconds: 5400,
  closeout_seconds: 60,
  tool_timeout_seconds: 300,
  result_repairs: 1,
  capture_enabled: true,
  skip_informational_review: false,
  read_only_fields: [],
  model: {
    id: "deepseek-chat",
    provider: "",
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    api: "openai-completions",
    context_window: 65536,
    max_output_tokens: 8192,
  },
});

const blankReview = () => ({
  id: "",
  base_url: "",
  api_key: "",
  api: "openai-completions",
  provider: "",
  context_window: 0,
  max_output_tokens: 0,
});

test("空白审核模型等价于未启用：勾选后取消不会留下幽灵未保存项", () => {
  const config = base();
  const enabled = { ...config, review_model: blankReview() };
  assert.deepEqual(changedPaths(config, enabled), []);
  assert.deepEqual(changedPaths(enabled, config), []);
});

test("关闭审核模型后恢复草稿仍显示为未启用", () => {
  // 关闭开关时草稿里留下的是全空占位对象；按对象存在判断会把开关重新点亮，
  // 保存时的校验又会要求重新填写连接信息。
  assert.equal(reviewModelEnabled(undefined), false);
  assert.equal(reviewModelEnabled(null), false);
  assert.equal(reviewModelEnabled(blankReview()), false);
  assert.equal(reviewModelEnabled({ ...blankReview(), id: "deepseek-reasoner" }), true);
});

test("审核模型的真实改动仍按字段列出，保存条按卡片归并", () => {
  const config = { ...base(), review_model: blankReview() };
  const draft = {
    ...config,
    review_model: { ...blankReview(), id: "deepseek-reasoner", base_url: "https://api.deepseek.com/v1" },
  };
  const changes = changedPaths(config, draft);
  assert.ok(changes.includes("review_model.id"));
  assert.ok(changes.includes("review_model.base_url"));
  assert.deepEqual(changeSummary(changes), ["审核模型"]);
  assert.deepEqual(changeSummary(["max_workers", "model.base_url"]), ["总并发", "主模型"]);
});

test("数字字段按服务端约束就地校验：任务超时只接受 0 或至少 30 秒", () => {
  const errors = runtimeFieldErrors({ ...base(), task_timeout_seconds: 10 }, false);
  assert.match(errors.task_timeout_seconds, /30/);
  assert.deepEqual(runtimeFieldErrors({ ...base(), task_timeout_seconds: 0 }, false).task_timeout_seconds, undefined);
  assert.deepEqual(runtimeFieldErrors({ ...base(), task_timeout_seconds: 30 }, false).task_timeout_seconds, undefined);
  assert.match(
    runtimeFieldErrors({ ...base(), task_timeout_seconds: 30, closeout_seconds: 30 }, false).closeout_seconds,
    /小于/,
  );
});

test("并发与预算字段拒绝越界和非整数，启用独立审核模型必须填齐连接信息", () => {
  const errors = runtimeFieldErrors(
    {
      ...base(),
      max_workers: 99,
      max_project_workers: 2.5,
      interval_ms: 120,
      debounce_ms: -1,
      result_repairs: 4,
      tool_timeout_seconds: 999,
      review_model: blankReview(),
    },
    true,
  );
  for (const key of [
    "max_workers",
    "max_project_workers",
    "interval_ms",
    "debounce_ms",
    "result_repairs",
    "tool_timeout_seconds",
    "review_model.id",
    "review_model.base_url",
  ])
    assert.ok(errors[key], `${key} 应有校验提示`);
  assert.deepEqual(runtimeFieldErrors({ ...base(), review_model: blankReview() }, false), {});
  // 原生 Pi 供应商可以省略地址；自定义 / 中转必须填写。
  const native = { ...base(), review_model: { ...blankReview(), id: "m", provider: "deepseek" } };
  assert.equal(runtimeFieldErrors(native, true)["review_model.base_url"], undefined);
  const custom = { ...base(), review_model: { ...blankReview(), id: "m", provider: "custom" } };
  assert.ok(runtimeFieldErrors(custom, true)["review_model.base_url"]);
});
