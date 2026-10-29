import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { DispatchConfig } from "../../../packages/protocol/src/index.js";
import { MODEL_APIS, normalizeModelBaseURL } from "../../../packages/protocol/src/model-config.js";
export { normalizeModelBaseURL };

export const modelSchema = z.object({
  id: z.string().trim(),
  provider: z.string().trim().default(""),
  base_url: z
    .string()
    .trim()
    .default("")
    .refine(
      (v) => !v || (/^https?:\/\//i.test(v) && URL.canParse(v) && !new URL(v).username && !new URL(v).password),
      "API 地址必须是 HTTP 或 HTTPS 地址，且不能内嵌凭据",
    )
    .transform((v) => normalizeModelBaseURL(v)),
  api_key: z.string().default(""),
  api: z.enum(MODEL_APIS).default("openai-completions"),
  context_window: z
    .number()
    .int()
    .refine((v) => v === 0 || v >= 4096, "上下文窗口须为 0（自动）或至少 4096")
    .default(0),
  max_output_tokens: z.number().int().min(0).default(0),
  disable_thinking: z.boolean().optional(),
});
// The webhook is a secret-bearing URL. Validate it as HTTPS (Feishu only accepts
// https hooks) but allow an empty string so notifications can be left off.
const feishuWebhookSchema = z
  .string()
  .trim()
  .default("")
  .refine((v) => !v || (/^https:\/\//i.test(v) && URL.canParse(v)), "飞书 Webhook 必须是 HTTPS 地址");
export const notificationSchema = z.object({
  feishu_webhook: feishuWebhookSchema,
  notify_new_finding: z.boolean().default(false),
  notify_needs_human: z.boolean().default(false),
});
export const configSchema = z
  .object({
    server: z.string().url(),
    worker_image: z.string().min(1),
    network: z.string().min(1),
    volume_prefix: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    max_workers: z.number().int().min(1).max(64),
    max_project_workers: z.number().int().min(1).max(32),
    max_project_review_workers: z.number().int().min(1).max(32).default(1),
    interval_ms: z.number().int().min(500),
    debounce_ms: z.number().int().min(0),
    task_timeout_seconds: z
      .number()
      .int()
      .refine((v) => v === 0 || v >= 30, "Task timeout must be 0 (unlimited) or at least 30 seconds"),
    closeout_seconds: z.number().int().min(1).max(300).optional(),
    tool_timeout_seconds: z.number().int().min(0).max(600).default(0),
    result_repairs: z.number().int().min(0).max(3).default(2),
    capture_enabled: z.boolean().default(true),
    skip_informational_review: z.boolean().default(false),
    /** 0 = unlimited. Default 2 forces Decide to prioritise instead of queueing more work. */
    max_new_steps_per_round: z.number().int().min(0).max(64).default(2),
    /** 0 = unlimited. Default 8 caps the open queue so a project cannot drift sideways. */
    max_open_steps: z.number().int().min(0).max(256).default(8),
    notifications: notificationSchema.default({
      feishu_webhook: "",
      notify_new_finding: false,
      notify_needs_human: false,
    }),
    model: modelSchema,
    review_model: modelSchema.optional(),
  })
  .strict()
  .transform((v) => ({
    ...v,
    model: { ...v.model, base_url: normalizeModelBaseURL(v.model.base_url, v.model.api) },
    review_model: v.review_model
      ? { ...v.review_model, base_url: normalizeModelBaseURL(v.review_model.base_url, v.review_model.api) }
      : undefined,
    closeout_seconds:
      v.closeout_seconds ?? (v.task_timeout_seconds === 0 ? 60 : Math.min(60, Math.floor(v.task_timeout_seconds / 3))),
  }))
  .refine(
    (v) => v.task_timeout_seconds === 0 || v.closeout_seconds < v.task_timeout_seconds,
    "Closeout reserve must be shorter than the task deadline",
  );
export class RuntimeConfig {
  value: DispatchConfig;
  private persisted: Record<string, unknown>;
  private overrides: Record<string, unknown> = {};
  readonly readOnlyFields: string[] = [];
  private defaults = {
    server: "http://tessera-server:8000",
    worker_image: "tessera-runtime:0.3.0",
    network: "tessera-network",
    volume_prefix: "tessera",
    max_workers: 4,
    max_project_workers: 4,
    interval_ms: 1000,
    debounce_ms: 2000,
    task_timeout_seconds: 0,
    capture_enabled: true,
    skip_informational_review: false,
    max_new_steps_per_round: 2,
    max_open_steps: 8,
    notifications: {
      // Empty by default: tests and fresh installs never deliver until an operator
      // pastes a webhook in Settings. Both switches start on so filling the webhook
      // is the only step needed.
      feishu_webhook: "",
      notify_new_finding: true,
      notify_needs_human: true,
    },
    model: {
      id: "",
      base_url: "",
      api_key: "",
      api: "openai-completions",
      context_window: 0,
    },
  };
  constructor(
    private file: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.persisted = existsSync(file)
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")))
      : {};
    // `true` = numbers, "boolean" = booleans, omitted = strings. Deployments can
    // force the informational-review switch so it cannot be re-enabled in the UI.
    const specs: [string, string, (boolean | "boolean")?][] = [
      ["TESSERA_INTERNAL_URL", "server"],
      ["TESSERA_WORKER_IMAGE", "worker_image"],
      ["TESSERA_NETWORK", "network"],
      ["TESSERA_VOLUME_PREFIX", "volume_prefix"],
      ["TESSERA_MAX_WORKERS", "max_workers", true],
      ["TESSERA_MAX_PROJECT_WORKERS", "max_project_workers", true],
      ["TESSERA_MAX_PROJECT_REVIEW_WORKERS", "max_project_review_workers", true],
      ["TESSERA_INTERVAL_MS", "interval_ms", true],
      ["TESSERA_DEBOUNCE_MS", "debounce_ms", true],
      ["TESSERA_TASK_TIMEOUT_SECONDS", "task_timeout_seconds", true],
      ["TESSERA_CLOSEOUT_SECONDS", "closeout_seconds", true],
      ["TESSERA_TOOL_TIMEOUT_SECONDS", "tool_timeout_seconds", true],
      ["TESSERA_RESULT_REPAIRS", "result_repairs", true],
      ["TESSERA_SKIP_INFORMATIONAL_REVIEW", "skip_informational_review", "boolean"],
      ["TESSERA_MAX_NEW_STEPS_PER_ROUND", "max_new_steps_per_round", true],
      ["TESSERA_MAX_OPEN_STEPS", "max_open_steps", true],
      ["TESSERA_FEISHU_WEBHOOK", "notifications.feishu_webhook"],
      ["TESSERA_NOTIFY_NEW_FINDING", "notifications.notify_new_finding", "boolean"],
      ["TESSERA_NOTIFY_NEEDS_HUMAN", "notifications.notify_needs_human", "boolean"],
      ["PI_MODEL", "model.id"],
      ["PI_BASE_URL", "model.base_url"],
      ["PI_API_KEY", "model.api_key"],
      ["PI_PROVIDER", "model.provider"],
      ["PI_MAX_OUTPUT_TOKENS", "model.max_output_tokens", true],
      ["PI_PROVIDER_API", "model.api"],
      ["PI_CONTEXT_WINDOW", "model.context_window", true],
      ["PI_REVIEW_MODEL", "review_model.id"],
      ["PI_REVIEW_BASE_URL", "review_model.base_url"],
      ["PI_REVIEW_API_KEY", "review_model.api_key"],
      ["PI_REVIEW_PROVIDER", "review_model.provider"],
      ["PI_REVIEW_MAX_OUTPUT_TOKENS", "review_model.max_output_tokens", true],
      ["PI_REVIEW_PROVIDER_API", "review_model.api"],
      ["PI_REVIEW_CONTEXT_WINDOW", "review_model.context_window", true],
    ];
    for (const [name, path, coerce] of specs) {
      const raw = environment[name];
      if (raw === undefined || raw.trim() === "") continue;
      const [parent, field] = path.split(".");
      const value =
        coerce === "boolean"
          ? /^(?:1|true|yes|on)$/i.test(raw.trim())
            ? true
            : /^(?:0|false|no|off)$/i.test(raw.trim())
              ? false
              : (() => {
                  throw new Error(`Invalid boolean environment variable: ${name}`);
                })()
          : coerce
            ? Number(raw)
            : raw;
      if (coerce === true && !Number.isFinite(value)) throw new Error(`Invalid numeric environment variable: ${name}`);
      if (field) {
        const model = this.overrides[parent] as Record<string, unknown> | undefined;
        this.overrides[parent] = { ...model, [field]: value };
      } else this.overrides[parent] = value;
      this.readOnlyFields.push(path);
    }
    this.value = this.effective(this.persisted);
  }
  private merge(base: Record<string, unknown>, patch: Record<string, unknown>) {
    const value = { ...base, ...patch };
    for (const key of ["model", "review_model", "notifications"]) {
      if (patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key]))
        value[key] = { ...(base[key] as object), ...(patch[key] as object) };
    }
    return value;
  }
  private effective(persisted: Record<string, unknown>): DispatchConfig {
    let base = this.merge(this.defaults, persisted);
    if (base.review_model || this.overrides.review_model)
      base = { ...base, review_model: { ...this.defaults.model, ...(base.review_model as object) } };
    const value = configSchema.parse(this.merge(base, this.overrides));
    if (value.review_model) {
      if (
        !value.review_model.id &&
        !value.review_model.base_url &&
        !value.review_model.provider &&
        !value.review_model.api_key &&
        !this.overrides.review_model
      )
        value.review_model = undefined;
      else if (
        !value.review_model.id ||
        (!value.review_model.base_url && (!value.review_model.provider || value.review_model.provider === "custom"))
      )
        throw new Error("Review model requires a model ID and either a Pi provider or API URL");
    }
    return value;
  }
  redacted() {
    const hide = (m: DispatchConfig["model"]) => ({
      ...m,
      api_key: "",
      api_key_set: !!m.api_key,
    });
    // The webhook carries its own bot secret in the URL path, so it is masked to
    // "set" metadata exactly like an API key and never echoed back verbatim.
    const hideWebhook = (n: DispatchConfig["notifications"]) => ({
      feishu_webhook: "",
      feishu_webhook_set: !!n?.feishu_webhook,
      notify_new_finding: n?.notify_new_finding === true,
      notify_needs_human: n?.notify_needs_human === true,
    });
    const { server, worker_image, network, volume_prefix, ...publicValue } = this.value;
    return {
      ...publicValue,
      read_only_fields: [...this.readOnlyFields],
      model: hide(this.value.model),
      review_model: this.value.review_model ? hide(this.value.review_model) : undefined,
      notifications: hideWebhook(this.value.notifications),
    };
  }
  requireModel() {
    if (!this.value.model.base_url && (!this.value.model.provider || this.value.model.provider === "custom"))
      throw new Error("请先在设置中选择供应商或填写 API 地址，再启动任务。");
    if (!this.value.model.id) throw new Error("请先在设置中选择模型，再启动任务。");
  }
  updatePublic(input: unknown) {
    const body = z.record(z.string(), z.unknown()).parse(input);
    for (const key of ["server", "worker_image", "network", "volume_prefix"])
      if (key in body) throw new Error("运行环境由服务端管理");
    return this.update(body);
  }
  update(input: unknown) {
    const { read_only_fields: _metadata, ...patch } = z.record(z.string(), z.unknown()).parse(input);
    for (const path of this.readOnlyFields) {
      const [parent, field] = path.split(".");
      if (
        field
          ? parent in patch &&
            (patch[parent] === null ||
              typeof patch[parent] !== "object" ||
              Object.prototype.hasOwnProperty.call(patch[parent], field))
          : parent in patch
      )
        throw new Error("该字段由部署配置管理，不能通过设置接口修改");
    }
    const persisted = this.merge(structuredClone(this.persisted), patch);
    for (const key of ["model", "review_model"]) {
      const model = persisted[key] as Record<string, unknown> | undefined;
      if (!model || typeof model !== "object") continue;
      delete model.api_key_set;
      const previous = this.persisted[key] as Record<string, unknown> | undefined;
      const incoming = patch[key] as Record<string, unknown> | undefined;
      if (
        key === "review_model" &&
        incoming?.id === "" &&
        incoming.base_url === "" &&
        !incoming.provider &&
        !incoming.api_key
      ) {
        delete persisted.review_model;
        continue;
      }
      const changedEndpoint =
        incoming &&
        "base_url" in incoming &&
        normalizeModelBaseURL(String(incoming.base_url), String(incoming.api ?? previous?.api ?? "")) !==
          normalizeModelBaseURL(
            String(previous?.base_url ?? this.defaults.model.base_url),
            String(previous?.api ?? ""),
          );
      const nativeProvider = (provider: unknown) => {
        const value = String(provider ?? "");
        return value !== "" && value !== "custom";
      };
      // Endpoint mode and custom mode share the same connection, so switching only
      // the catalog-matching mode must not discard the stored key.
      const changedProvider =
        incoming &&
        "provider" in incoming &&
        String(incoming.provider ?? "") !== String(previous?.provider ?? "") &&
        (nativeProvider(incoming.provider) || nativeProvider(previous?.provider));
      if ((changedEndpoint || changedProvider) && !incoming?.api_key) model.api_key = "";
      else if (incoming && incoming.api_key === "") model.api_key = previous?.api_key ?? "";
    }
    // Same masked-secret rule as model keys: an empty submitted webhook keeps the
    // stored one; the operator explicitly clears it by setting the field to a
    // single "-" so an accidental blank never drops the delivery channel.
    {
      const notifications = persisted.notifications as Record<string, unknown> | undefined;
      if (notifications && typeof notifications === "object") {
        delete notifications.feishu_webhook_set;
        const previous = this.persisted.notifications as Record<string, unknown> | undefined;
        const incoming = patch.notifications as Record<string, unknown> | undefined;
        if (incoming && incoming.feishu_webhook === "") {
          notifications.feishu_webhook = previous?.feishu_webhook ?? this.defaults.notifications.feishu_webhook;
        } else if (incoming && incoming.feishu_webhook === "-") {
          notifications.feishu_webhook = "";
        }
      }
    }
    const value = this.effective(persisted);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    this.persisted = persisted;
    this.value = value;
    return this.redacted();
  }
}
