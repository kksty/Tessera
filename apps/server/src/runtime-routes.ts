import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "../../../packages/core/src/errors.js";
import { modelIssue, redactModelError } from "../../../packages/protocol/src/model-errors.js";
import type { ModelConfig, ModelMetadata } from "../../../packages/protocol/src/model-config.js";
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

// Connectivity is not capacity: a 16-token ping keeps answering when the endpoint
// silently drops every request big enough to matter. The probe therefore spends
// the budget a real Run spends — a context sized from the declared window plus the
// declared output ceiling — so a deployment that cannot honour the declaration
// fails at the settings check instead of mid-Run with an empty stream.
// The ceiling bounds the cost; the floor only keeps a degenerate budget from
// producing an empty prompt. Never exceed the declared prompt allowance, so a
// genuinely small window is not failed by the probe itself.
const PROBE_CONTEXT_CEILING = 32768;
const PROBE_CONTEXT_MINIMUM = 512;
const PROBE_SAFETY_TOKENS = 4096;
// Pi budgets with 3.5 characters per token. Sizing the filler by Pi's own constant
// keeps Pi's clamp authoritative, so the probe can never overrun the declaration.
const PROBE_CHARS_PER_TOKEN = 3.5;
const PROBE_TIMEOUT_MS = 180_000;
// Join before splitting: `a + b + c.split(" ")` would coerce the array back into a
// comma-joined string, so indexing it would yield single characters and commas.
const PROBE_VOCABULARY = [
  "asset finding evidence probe context boundary request decision review step observation graph revision",
  "worker lease heartbeat session fingerprint capacity window completion stream transport adapter provider",
  "endpoint credential envelope render surface anchor receipt queue batch retry deadline budget",
]
  .join(" ")
  .split(" ");

function probeBudget(metadata: ModelMetadata) {
  const available = metadata.context_window - metadata.max_output_tokens - PROBE_SAFETY_TOKENS;
  return {
    context: Math.max(PROBE_CONTEXT_MINIMUM, Math.min(PROBE_CONTEXT_CEILING, available)),
    output: metadata.max_output_tokens,
  };
}

/** Varied ASCII filler tokenizes close to Pi's estimate; repeated lines collapse. */
function probeFiller(tokens: number) {
  let seed = 0x9e3779b9;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const target = Math.ceil(tokens * PROBE_CHARS_PER_TOKEN);
  const words: string[] = [];
  for (let size = 0; size < target;) {
    const word = PROBE_VOCABULARY[Math.floor(random() * PROBE_VOCABULARY.length)];
    const sample = random() < 0.1 ? `${word}-${Math.floor(random() * 100000)}` : word;
    words.push(sample);
    size += sample.length + 1;
  }
  return words.join(" ");
}
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
      normalizeModelBaseURL(b.base_url, b.api) === normalizeModelBaseURL(stored.base_url, stored.api) &&
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
  const capacityFailure = (
    metadata: ModelMetadata,
    budget: { context: number; output: number },
    sent: number | null,
    elapsed: number,
    error: unknown,
    key: string,
  ) => {
    const detail = redactModelError(error instanceof Error ? error.message : String(error), [key]).slice(0, 300);
    const issue = modelIssue(`Context capacity probe failed: ${detail}`);
    // An endpoint that accepts an oversized request and then returns nothing is the
    // failure this probe exists for, so name the numbers instead of the transport.
    return new DomainError(
      422,
      `${issue?.title ?? "上下文预算不足"}：已按「上下文检测 ${budget.context.toLocaleString()} tokens + 输出上限 ` +
        `${(sent ?? budget.output).toLocaleString()} tokens」（声明窗口 ${metadata.context_window.toLocaleString()}）` +
        `发出真实请求，${elapsed.toLocaleString()} ms 后没有得到完整响应（${detail || "空响应"}）。` +
        `${issue?.action ?? "请按部署实际能力下调上下文窗口或输出上限，然后重新检测。"}`,
    );
  };
  api.post("/runtime/model-check", async (req) => {
    operatorCheck(req);
    const cfg = modelInput(req.body);
    if (!cfg.id) throw new DomainError(422, "请先选择模型。");
    const started = Date.now();
    try {
      const { runtime: pi, model, metadata } = await configuredModel(cfg);
      const budget = probeBudget(metadata);
      // Pi clamps this against the remaining window, so record what actually went out.
      let sent: number | null = null;
      const result = await pi.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: `${probeFiller(budget.context)}\n\n以上内容与本任务无关，仅用于占用声明的上下文预算。只回复 OK。`,
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens: budget.output,
          maxRetries: 0,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          onPayload: (payload) => {
            const body = payload as Record<string, unknown>;
            const value = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
            if (Number.isFinite(value) && value > 0) sent = value;
          },
        },
      );
      const elapsed = Date.now() - started;
      // Pi reports uncached input in `input` and cache hits separately; the operator
      // needs the prompt the deployment actually saw, not only its cache miss.
      const usage = result.usage;
      const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
      if (result.stopReason === "error" || result.stopReason === "aborted")
        throw capacityFailure(metadata, budget, sent, elapsed, result.errorMessage || result.stopReason, cfg.api_key);
      if (!result.content.length)
        throw capacityFailure(metadata, budget, sent, elapsed, new Error("empty provider response"), cfg.api_key);
      return {
        ok: true,
        model: metadata,
        compaction: modelSettings(model).getCompactionSettings(model),
        elapsed_ms: elapsed,
        capacity: {
          context_window: metadata.context_window,
          output_limit: metadata.max_output_tokens,
          context_probe_tokens: budget.context,
          max_tokens: sent,
          prompt_tokens: promptTokens,
          cached_tokens: usage ? usage.cacheRead + usage.cacheWrite : null,
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
