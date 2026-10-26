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
