export const MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/** Store a base URL, including when an operator pastes a request endpoint. */
export function normalizeModelBaseURL(url: string, api?: string) {
  const base = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages)$/, "");
  // Pi's Anthropic transport appends /v1/messages itself.
  return api === "anthropic-messages" ? base.replace(/\/v1$/, "") : base;
}

/**
 * 目录匹配用的端点身份比较。
 * 官方 OpenAI 兼容端点常允许在基础地址后追加可选的 `/v1`（例如 DeepSeek 同时接受
 * `https://api.deepseek.com` 与 `https://api.deepseek.com/v1`）。目录与配置两侧都可能
 * 带或不带这个后缀，因此两个方向都放宽；实际请求仍使用配置里的地址。
 */
export function sameModelEndpoint(configured: string, catalog: string, api?: string) {
  const a = normalizeModelBaseURL(configured, api);
  const b = normalizeModelBaseURL(catalog, api);
  if (!a || !b) return false;
  if (a === b) return true;
  const withoutV1 = (url: string) => (url.endsWith("/v1") ? url.slice(0, -3) : url);
  return withoutV1(a) === withoutV1(b);
}

/**
 * 判断提交的模型是否仍指向已保存的同一部署，用于复用已保存的密钥。
 * 两个空地址都表示“同一个 Pi 原生供应商”，此时没有端点可比较；
 * 只有一侧为空时才是不同部署（原生供应商 vs. 显式地址）。
 */
export function sameModelDeployment(submitted: string, stored: string, api?: string) {
  if (!submitted.trim() && !stored.trim()) return true;
  return sameModelEndpoint(submitted, stored, api) || sameModelEndpoint(stored, submitted, api);
}

export interface ModelConfig {
  id: string;
  /** Empty selects a provider by its exact endpoint; custom disables inference. */
  provider?: string;
  base_url: string;
  api_key: string;
  api: string;
  /** 0 uses Pi metadata. Positive values impose a deployment-specific ceiling. */
  context_window: number;
  max_output_tokens?: number;
  /**
   * Ask the provider to disable its reasoning channel. vLLM/Qwen exposes this as
   * `chat_template_kwargs.enable_thinking=false`; a proxy that ignores the field
   * is unaffected. Off by default.
   */
  disable_thinking?: boolean;
}

export interface ModelMetadata {
  id: string;
  name: string;
  provider: string;
  api: string;
  base_url: string;
  context_window: number;
  max_output_tokens: number;
  context_source: "pi" | "configured" | "api" | "default";
  output_source: "pi" | "configured" | "default";
  reasoning: boolean;
  input: string[];
  /** Effective Pi auto-compaction budget for this model. */
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    /** Context size at which Pi compacts: window - reserveTokens (may be <= 0 for tiny windows). */
    threshold: number;
  };
  catalog_match?: {
    provider: string;
    id: string;
    context_window: number;
    max_output_tokens: number;
    via: "provider" | "endpoint";
  };
}

export interface ModelCatalogStatus {
  network_enabled: boolean;
  checked_at: string | null;
  refreshed_at: string | null;
  state: "builtin" | "ready" | "partial" | "failed" | "offline";
  failed_providers: string[];
  refresh_interval_ms: number;
}

export interface ModelProvider {
  id: string;
  name: string;
  base_url: string;
  api: string;
}
