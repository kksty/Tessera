import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "../../../packages/core/src/errors.js";
import { modelIssue, redactModelError } from "../../../packages/protocol/src/model-errors.js";
import { sameModelDeployment, type ModelConfig } from "../../../packages/protocol/src/model-config.js";
import {
  configuredModel,
  modelCatalog,
  modelCatalogStatus,
  modelMetadata,
  modelProviders,
  modelSettings,
} from "../../../packages/models/src/runtime.js";
import { RuntimeConfig, modelSchema, normalizeModelBaseURL } from "./runtime.js";

const modelInputSchema = modelSchema.extend({
  id: z.string().trim().default(""),
  scope: z.enum(["model", "review_model"]).optional(),
});

// The settings button is a connectivity test, not a capacity probe. Probing capacity
// means sending a prompt sized from the declared window — tens of thousands of input
// tokens per click — so an operator action cost as much as a real Run. This check
// sends one short prompt with a small output ceiling: it can prove that the endpoint,
// key and protocol answer, and it deliberately cannot prove that the declared window
// fits. Capacity surfaces in the first real Run, which fails into needs_attention
// with the numbers, not in the settings page.
const CHECK_PROMPT = "只回复 OK。";
const CHECK_MAX_TOKENS = 128;
const CHECK_TIMEOUT_MS = 60_000;
export function registerRuntimeRoutes(
  api: FastifyInstance,
  runtime: RuntimeConfig,
  operatorCheck: (req: FastifyRequest) => void,
  workerCheck: (req: FastifyRequest) => void,
  onUpdate?: (value: RuntimeConfig["value"]) => void,
) {
  api.get("/runtime", (req) => {
    operatorCheck(req);
    return runtime.redacted();
  });
  api.get("/runtime/providers", async (req) => {
    operatorCheck(req);
    return modelProviders();
  });
  api.get("/runtime/catalog-status", async (req) => {
    operatorCheck(req);
    return modelCatalogStatus();
  });
  api.post("/runtime/catalog-refresh", async (req) => {
    operatorCheck(req);
    return modelCatalogStatus(true);
  });
  api.get("/runtime/catalog", async (req) => {
    operatorCheck(req);
    return modelCatalog();
  });
  api.post("/runtime/catalog", async (req) => {
    operatorCheck(req);
    try {
      return await modelCatalog(modelInputSchema.parse(req.body));
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw new DomainError(422, (error as Error).message);
    }
  });
  api.put("/runtime", (req) => {
    // Settings are an operator action. The internal token must not be able to
    // change deployment fields (server, image, network, volume prefix).
    operatorCheck(req);
    try {
      const redacted = runtime.updatePublic(req.body);
      onUpdate?.(runtime.value);
      return redacted;
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new DomainError(422, (e as Error).message);
    }
  });
  const modelInput = (body: unknown) => {
    const b = modelInputSchema.parse(body);
    const matches = (stored: ModelConfig) =>
      sameModelDeployment(b.base_url, stored.base_url, b.api) &&
      (b.provider || "") === (stored.provider || "") &&
      b.api === stored.api;
    const candidates = b.scope
      ? [runtime.value[b.scope]].filter((m): m is ModelConfig => !!m && matches(m))
      : [runtime.value.model, runtime.value.review_model].filter((m): m is ModelConfig => !!m && matches(m));
    // Main and review may use separate accounts on the same endpoint.
    const keys = new Set(candidates.map((m) => m.api_key));
    return { ...b, api_key: b.api_key || (keys.size === 1 ? candidates[0].api_key : "") };
  };
  const modelFailure = (error: unknown, key: string) => {
    const raw = `Model provider failure: ${redactModelError(error instanceof Error ? error.message : String(error), [key])}`;
    const issue = modelIssue(raw)!;
    return new DomainError(422, `${issue.title}：${issue.action}`);
  };
  api.post("/runtime/model-check", async (req) => {
    operatorCheck(req);
    const cfg = modelInput(req.body);
    if (!cfg.id) throw new DomainError(422, "请先选择模型。");
    const started = Date.now();
    try {
      const { runtime: pi, model, metadata } = await configuredModel(cfg);
      // One short prompt, small output ceiling: the whole request costs a few dozen
      // tokens, so the operator can press this button without burning Run budget.
      const result = await pi.completeSimple(
        model,
        { messages: [{ role: "user", content: CHECK_PROMPT, timestamp: Date.now() }] },
        { maxTokens: CHECK_MAX_TOKENS, maxRetries: 0, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
      );
      const elapsed = Date.now() - started;
      // Pi reports uncached input in `input` and cache hits separately; the operator
      // needs the prompt the deployment actually saw, not only its cache miss.
      const usage = result.usage;
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        const detail = redactModelError(result.errorMessage || result.stopReason, [cfg.api_key]).slice(0, 300);
        const issue = modelIssue(`Model provider failure: ${detail}`);
        throw new DomainError(
          422,
          `连接测试失败：已发出一次极短请求，${elapsed.toLocaleString()} ms 后没有得到完整响应（${detail || "空响应"}）。` +
            `${issue?.action ?? "请检查 API 地址、密钥与接口协议，保存后再用真实任务验证。"}`,
        );
      }
      return {
        ok: true,
        model: metadata,
        compaction: modelSettings(model).getCompactionSettings(model),
        elapsed_ms: elapsed,
        reply: result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
          .trim()
          .slice(0, 200),
        usage: {
          prompt_tokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : null,
          completion_tokens: usage?.output ?? null,
        },
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw modelFailure(error, cfg.api_key);
    }
  });
  api.post("/runtime/model-metadata", async (req) => {
    operatorCheck(req);
    const cfg = modelInputSchema.parse(req.body);
    try {
      return await modelMetadata(cfg);
    } catch (error) {
      throw new DomainError(422, (error as Error).message);
    }
  });
  api.post("/runtime/models", async (req) => {
    operatorCheck(req);
    const b = modelInput(req.body);
    // Native providers need not expose a nonstandard /models endpoint.
    if (!b.base_url && b.provider && b.provider !== "custom") {
      try {
        return await modelCatalog(b);
      } catch (error) {
        throw new DomainError(422, (error as Error).message);
      }
    }
    if (!b.base_url) throw new DomainError(422, "请先选择供应商或填写 API 地址。");
    const base = normalizeModelBaseURL(b.base_url, b.api);
    const key = b.api_key;
    const url =
      b.api === "anthropic-messages"
        ? base.endsWith("/v1")
          ? base + "/models"
          : base + "/v1/models"
        : base + "/models";
    const headers: Record<string, string> =
      b.api === "anthropic-messages"
        ? { ...(key ? { "x-api-key": key } : {}), "anthropic-version": "2023-06-01" }
        : key
          ? { Authorization: `Bearer ${key}` }
          : {};
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const raw = `Model provider failure: ${redactModelError(error instanceof Error ? error.message : "Network failure", [key])}`;
      const issue = modelIssue(raw)!;
      throw new DomainError(422, `${issue.title}：${issue.action}`);
    }
    if (!response.ok) {
      const raw = `Model provider failure: ${response.status}: ${redactModelError((await response.text()).slice(0, 5000), [key])}`;
      const issue = modelIssue(raw)!;
      throw new DomainError(422, `${issue.title}（${response.status}）：${issue.action}`);
    }
    let data: {
      data?: Record<string, unknown>[];
      models?: Record<string, unknown>[];
      error?: unknown;
    };
    try {
      data = await response.json();
    } catch {
      throw new DomainError(422, "模型接口返回了无法解析的内容，请检查 API 地址和接口协议。");
    }
    if (!data || data.error) {
      const issue = modelIssue(`Model provider failure: ${redactModelError(JSON.stringify(data), [key])}`)!;
      throw new DomainError(422, `${issue.title}：${issue.action}`);
    }
    const rows = data.data || data.models || [];
    if (!Array.isArray(rows)) throw new DomainError(422, "模型接口返回了无效列表，请检查 API 地址和接口协议。");
    return Promise.all(
      rows
        .filter((m) => m && typeof m.id === "string")
        .map(async (m) => {
          const apiWindow = Number(
            m.context_window || m.max_model_len || m.context_length || m.max_context_tokens || m.contextWindow,
          );
          const id = String(m.id);
          const context = Number.isSafeInteger(apiWindow) && apiWindow >= 4096 ? apiWindow : 0;
          const output = Number(m.max_output_tokens || m.max_completion_tokens || m.maxTokens);
          const metadata = await modelMetadata({
            ...b,
            id,
            context_window: context,
            max_output_tokens: Number.isSafeInteger(output) && output > 0 ? output : 0,
          });
          return {
            ...metadata,
            name: String(m.display_name || m.name || metadata.name),
            context_source: context && metadata.context_window === context ? "api" : metadata.context_source,
          };
        }),
    );
  });
  api.get("/runtime/config", (req) => {
    workerCheck(req);
    // Dispatch now receives the safe Run snapshot from /jobs/claim; it never needs provider secrets.
    return {
      ...runtime.value,
      model: { ...runtime.value.model, api_key: "" },
      review_model: runtime.value.review_model ? { ...runtime.value.review_model, api_key: "" } : undefined,
    };
  });
}
