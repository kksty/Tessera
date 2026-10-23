import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { redactModelError } from "../../protocol/src/model-errors.js";

type StreamFn = AgentSession["agent"]["streamFunction"];
export interface RequestCounters {
  input: number | null;
  input_uncached: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
}
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Never substitute SDK's default cache zeros for a provider's missing fields. */
export function requestCounters(usage: { input: number; cacheRead: number; cacheWrite: number; output: number }, rawUsage: any): RequestCounters {
  const known = usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0 ||
    (count(rawUsage?.prompt_tokens) !== null && count(rawUsage?.completion_tokens) !== null) ||
    (count(rawUsage?.input_tokens) !== null && count(rawUsage?.output_tokens) !== null);
  return {
    input: known ? count(usage.input + usage.cacheRead + usage.cacheWrite) : null,
    input_uncached: known ? count(usage.input) : null,
    cache_read: count(rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.input_tokens_details?.cached_tokens ??
      rawUsage?.prompt_cache_hit_tokens ?? rawUsage?.cached_tokens ?? rawUsage?.cache_read_input_tokens) ??
      (usage.cacheRead > 0 ? count(usage.cacheRead) : null),
    cache_write: count(rawUsage?.prompt_tokens_details?.cache_write_tokens ?? rawUsage?.cache_creation_input_tokens) ??
      (usage.cacheWrite > 0 ? count(usage.cacheWrite) : null),
    output: known ? count(usage.output) : null,
  };
}

/** Adapters may report input at message_start and output at message_delta. */
export function mergeProviderUsage(previous: unknown, event: any): unknown {
  const usage = event?.usage ?? event?.message?.usage ?? event?.response?.usage;
  if (!usage || typeof usage !== "object") return previous;
  return { ...(previous as object), ...usage };
}

/** Copy public response content only: never persist reasoning blocks/signatures or headers. */
export function publicResponse(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redactModelError(value, secrets);
  }
  if (Array.isArray(value)) return value.filter(v => !v || !["thinking", "reasoning", "redacted_thinking"].includes(v.type)).map(v => publicResponse(v, secrets));
  if (!value || typeof value !== "object") return value;
  if ("type" in value && typeof value.type === "string" && /thinking|reasoning/.test(value.type)) return { type: value.type, omitted: true };
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/^(?:reasoning(?:_content|_details)?|thinking|signature|thinkingSignature|textSignature|encrypted_content|authorization|api[_-]?key|headers|cookie|set-cookie|password|secret|token|x-tessera-worker-token)$/i.test(key))
    .map(([key, v]) => [key, publicResponse(v, secrets)]));
}

/** Wrap the original stream and hooks without consuming, cloning or replacing the stream. */
export function observeModel(streamFn: StreamFn, options: {
  directory: string; runId?: string; secrets: string[]; requestPrefix?: string;
  requestMetadata?: () => Record<string, unknown>;
  start: (requestId: string) => void;
  complete: (requestId: string, counters: RequestCounters, hasToolCalls: boolean, stopReason?: string, errorMessage?: string) => void;
  failure: (requestId: string) => void;
  failed?: (requestId: string, error: unknown) => void;
  payload?: (requestId: string, metadata: Record<string, unknown>) => void;
  response?: (requestId: string, status: number) => void;
}) {
  let sequence = 0;
  const wrapper: StreamFn = async (model, context, original) => {
    const requestId = `${options.requestPrefix ?? "request"}_${++sequence}`;
    let rawUsage: unknown;
    let failed = false;
    const record = (type: string, data: unknown) => {
      if (failed) return;
      try {
        appendFileSync(join(options.directory, "model-responses.ndjson"), JSON.stringify({
          run_id: options.runId, request_id: requestId, at: new Date().toISOString(), type,
          data: publicResponse(data, options.secrets),
        }) + "\n", { mode: 0o600 });
      } catch { failed = true; options.failure(requestId); }
    };
    options.start(requestId);
    record("request_start", { model: model.id, api: model.api, capture: "parsed_provider_events_and_sdk_public_content", ...options.requestMetadata?.() });
    let stream;
    try { stream = await streamFn(model, context, {
      ...original,
      onPayload: async (payload, currentModel) => {
        const replacement = await original?.onPayload?.(payload, currentModel);
        // Capture only structural request metadata; credentials and prompts are never copied here.
        const body = (replacement === undefined ? payload : replacement) as Record<string, unknown>;
        const metadata = { chars: JSON.stringify(body)?.length,
          max_tokens: body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? null,
          response_format: (body?.response_format as { type?: string } | undefined)?.type ?? null };
        record("request_payload", metadata);
        options.payload?.(requestId, metadata);
        return replacement;
      },
      onResponse: async (response, currentModel) => {
        await original?.onResponse?.(response, currentModel);
        record("response", { status: response.status });
        options.response?.(requestId, response.status);
      },
      onProviderStreamEvent: async (data, currentModel) => {
        await original?.onProviderStreamEvent?.(data, currentModel);
        rawUsage = mergeProviderUsage(rawUsage, data);
        record("provider_event", data);
      },
    }); } catch (error) {
      try { options.failed?.(requestId, error); } catch {}
      throw error;
    }
    void stream.result().then(message => {
      record("sdk_message", message);
      const counters = requestCounters(message.usage, rawUsage);
      record("request_end", { counters, stop_reason: message.stopReason });
      options.complete(requestId, counters, message.content.some(c => c.type === "toolCall"), message.stopReason, message.errorMessage);
    }).catch(error => {
      try { options.failed?.(requestId, error); } catch {}
    });
    return stream;
  };
  return { stream: wrapper };
}
