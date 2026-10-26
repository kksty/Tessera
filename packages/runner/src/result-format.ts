import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Stream = AgentSession["agent"]["streamFunction"];

/**
 * Models that need the atomic final answer: a non-streaming completion in JSON
 * mode instead of free-form streaming. GLM-5 was the original case; the qwen
 * family is included because production runs returned degenerate fragments
 * ("I've now prepared my full reasoning…") that never parsed as the final JSON,
 * while guided JSON still works through vLLM. Only applied after exploration has
 * ended (see `serializing` in run.ts), never to task turns.
 */
export function useAtomicResult(api: string, id: string) {
  return api === "openai-completions" && (/^(?:z-ai\/)?glm-5$/i.test(id) || /^qwen/i.test(id));
}

/** Preserve complete provider text/arguments; translate the transport envelope only. */
export function completionEvents(completion: any): string {
  if (
    !Array.isArray(completion?.choices) ||
    !completion.choices.length ||
    completion.choices.some((choice: any) => !choice.message || typeof choice.index !== "number")
  )
    throw new Error("Model provider failure: invalid non-streaming completion envelope");
  const common = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const choices = completion.choices.map((choice: any) => ({
    index: choice.index,
    delta: {
      ...choice.message,
      ...(choice.message.tool_calls
        ? { tool_calls: choice.message.tool_calls.map((call: any, index: number) => ({ ...call, index })) }
        : {}),
    },
    finish_reason: choice.finish_reason,
  }));
  return `data: ${JSON.stringify({ ...common, choices, ...(completion.usage ? { usage: completion.usage } : {}) })}\n\ndata: [DONE]\n\n`;
}

/** During result repair or read-only recovery, request JSON mode without streaming and feed the
 * unchanged completion through Pi's parser/loop. This does not diagnose the original failure. */
export function finalCompletionFetch(
  upstream: typeof fetch = globalThis.fetch,
  capture?: (completion: unknown) => void,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
      return upstream(input, init);
    const body = JSON.parse(await request.clone().text());
    const { stream_options: _streamOptions, ...completionBody } = body;
    const response = await upstream(
      new Request(request, { body: JSON.stringify({ ...completionBody, stream: false }) }),
    );
    if (!response.ok) return response;
    const completion = await response.json();
    capture?.(completion);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("content-type", "text/event-stream");
    return new Response(completionEvents(completion), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Apply only after exploration has ended; never constrain tools or compaction summaries. */
export function withResultFormat(
  stream: Stream,
  serializing: () => boolean,
  capture?: (completion: unknown) => void,
): Stream {
  return async (model, context, options) => {
    if (!serializing() || !useAtomicResult(model.api, model.id)) return stream(model, context, options);
    return stream(model, context, {
      ...options,
      fetch: finalCompletionFetch(options?.fetch, capture),
      onPayload: async (payload, currentModel) => {
        const previous = await options?.onPayload?.(payload, currentModel);
        const body = (previous === undefined ? payload : previous) as Record<string, unknown>;
        return { ...body, response_format: { type: "json_object" } };
      },
    });
  };
}
