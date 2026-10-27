import type { RuntimeConfig } from "./workspace.js";

/** 未保存项的中文名称；未覆盖的键回退成路径本身。 */
export const FIELD_LABELS: Record<string, string> = {
  "model.provider": "接入方式",
  "model.max_output_tokens": "输出上限",
  "model.base_url": "API 地址",
  "model.api_key": "API Key",
  "model.api": "接口协议",
  "model.id": "模型",
  "model.context_window": "上下文窗口",
  "model.disable_thinking": "关闭模型思考通道",
  "review_model.base_url": "审核模型 API 地址",
  "review_model.api_key": "审核模型 API Key",
  "review_model.api": "审核模型接口协议",
  "review_model.id": "审核模型",
  "review_model.context_window": "审核模型上下文窗口",
  "review_model.provider": "审核模型接入方式",
  "review_model.max_output_tokens": "审核模型输出上限",
  max_workers: "总并发",
  max_project_workers: "单项目并发",
  max_project_review_workers: "单项目审核并发",
  interval_ms: "调度间隔",
  debounce_ms: "决策合并等待",
  task_timeout_seconds: "单次任务超时",
  closeout_seconds: "收尾预留",
  tool_timeout_seconds: "命令上限",
  result_repairs: "结果修复次数",
  capture_enabled: "录制代理",
  skip_informational_review: "信息类免审",
};

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

/** 四项连接信息全为空时，服务端会把这个审核模型当作未启用并丢弃。 */
function isBlankReviewModel(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  return ["id", "base_url", "api_key", "provider"].every((key) => key in model && model[key] === "");
}

/** 审核模型是否真的启用：关闭开关后草稿里留下的是全空占位对象，不能按“存在”判断。 */
export function reviewModelEnabled(value: unknown) {
  return !!value && typeof value === "object" && !Array.isArray(value) && !isBlankReviewModel(value);
}

/** 按保存载荷的形状比较：空白审核模型等价于未启用，不会产生幽灵未保存项。 */
export function changedPaths(baseline: unknown, draft: unknown) {
  const normalize = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    if (isBlankReviewModel(copy.review_model)) delete copy.review_model;
    return copy;
  };
  const before = flatten(normalize(baseline));
  const after = flatten(normalize(draft));
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/** 保存条的摘要：模型对象按一张卡片归并，其余字段逐项展示。 */
export function changeSummary(changes: string[]) {
  const labels: string[] = [];
  for (const path of changes) {
    const label = path.startsWith("review_model.")
      ? "审核模型"
      : path.startsWith("model.")
        ? "主模型"
        : (FIELD_LABELS[path] ?? path);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** 与服务端 runtime 校验保持一致，提前在字段下方给出可修正的提示。 */
export function runtimeFieldErrors(config: RuntimeConfig, reviewEnabled: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const integerIn = (key: string, value: number, min: number, max: number, message: string) => {
    if (!Number.isInteger(value) || value < min || value > max) errors[key] = message;
  };
  integerIn("max_workers", config.max_workers, 1, 64, "总并发需为 1–64 的整数");
  integerIn("max_project_workers", config.max_project_workers, 1, 32, "单项目并发需为 1–32 的整数");
  integerIn(
    "max_project_review_workers",
    config.max_project_review_workers ?? 1,
    1,
    32,
    "单项目审核并发需为 1–32 的整数",
  );
  if (!Number.isInteger(config.interval_ms) || config.interval_ms < 500)
    errors.interval_ms = "调度间隔需为不小于 500 的整数";
  if (!Number.isInteger(config.debounce_ms) || config.debounce_ms < 0) errors.debounce_ms = "决策合并等待不能为负数";
  // 服务端约束：0 表示不限时，其余至少 30 秒；此前这里可以填写 1–29，保存必然失败。
  if (
    !Number.isInteger(config.task_timeout_seconds) ||
    (config.task_timeout_seconds !== 0 && config.task_timeout_seconds < 30)
  )
    errors.task_timeout_seconds = "填 0（不限时）或至少 30 秒";
  const closeout = config.closeout_seconds ?? 60;
  if (!Number.isInteger(closeout) || closeout < 1 || closeout > 300)
    errors.closeout_seconds = "收尾预留需为 1–300 的整数";
  else if (config.task_timeout_seconds > 0 && closeout >= config.task_timeout_seconds)
    errors.closeout_seconds = "收尾预留必须小于单次任务超时";
  integerIn("tool_timeout_seconds", config.tool_timeout_seconds ?? 0, 0, 600, "命令上限需为 0–600 的整数");
  integerIn("result_repairs", config.result_repairs ?? 1, 0, 3, "结果修复次数需为 0–3 的整数");
  if (reviewEnabled && config.review_model) {
    if (!config.review_model.id) errors["review_model.id"] = "启用独立审核模型需要选择或填写模型";
    if (!config.review_model.base_url && (!config.review_model.provider || config.review_model.provider === "custom"))
      errors["review_model.base_url"] = "启用独立审核模型需要填写 API 地址";
  }
  return errors;
}
