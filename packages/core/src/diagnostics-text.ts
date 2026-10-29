import { redactModelError } from "../../protocol/src/model-errors.js";

/** Shareable content is separate from runtime input. Preserve JSON syntax while redacting values. */
export function diagnosticValue(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string")
    return diagnosticText(
      value.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "[thinking omitted]"),
      secrets,
      Number.MAX_SAFE_INTEGER,
    );
  if (Array.isArray(value))
    return value
      .filter((item) => !item || !["thinking", "reasoning", "redacted_thinking"].includes(item.type))
      .map((item) => diagnosticValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  if ("type" in value && value.type === "image") {
    const image = value as { type: string; mimeType?: string; data?: string };
    return { type: "image", mimeType: image.mimeType, omitted: true, encoded_chars: image.data?.length ?? null };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /^(?:reasoning(?:_content|_details)?|thinking|signature|thinkingSignature|textSignature|encrypted_content|headers)$/i.test(
        key,
      )
        ? "[omitted]"
        : /^(?:authorization|api[_-]?key|cookie|set-cookie|password|passwd|secret|token|x-tessera-worker-token)$/i.test(
              key,
            )
          ? "[redacted]"
          : diagnosticValue(item, secrets),
    ]),
  );
}

/** Bounded diagnostic excerpts; original artifacts stay in Evidence/workspace. */
export function diagnosticText(value: unknown, secrets: string[] = [], limit = 2048): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return redactModelError(text, secrets)
    .replace(/((?:authorization|cookie|set-cookie)\s*[":=]+\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1[redacted]")
    .slice(0, limit);
}
