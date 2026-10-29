import { createHash, randomUUID } from "node:crypto";
import { Diagnostic } from "./diagnostics-schema.js";
import { diagnosticValue } from "./diagnostics-text.js";

/** Explicitly chunk a redacted trace; hashes describe the log copy, never original Evidence. */
export class ValidationTraces {
  chars = 0;
  omitted = 0;
  constructor(
    readonly emit: (type: Diagnostic["type"], data: Record<string, unknown>) => void,
    readonly secrets: string[] = [],
    readonly runLimit = 8 * 1024 * 1024,
    readonly traceLimit = 256 * 1024,
  ) {}
  record(kind: string, value: unknown, context: Record<string, unknown> = {}) {
    try {
      const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
      const cleaned =
        typeof value === "string"
          ? String(diagnosticValue(value, this.secrets))
          : JSON.stringify(diagnosticValue(value, this.secrets));
      const trace_id = randomUUID(),
        available = Math.max(0, Math.min(this.traceLimit, this.runLimit - this.chars));
      const text = cleaned.slice(0, available),
        truncated = text.length < cleaned.length;
      const meta = {
        ...context,
        trace_id,
        kind,
        format: typeof value === "string" ? "text" : "json",
        original_chars: raw.length,
        redacted_chars: cleaned.length,
        recorded_chars: text.length,
        redacted: raw !== cleaned,
        truncated,
        log_sha256: createHash("sha256").update(cleaned).digest("hex"),
      };
      if (!available) {
        this.omitted++;
        // One explicit limit event is enough; keep the normal event stream and final outcome alive.
        if (this.omitted === 1) this.emit("validation_trace_limit", { ...context, kind, limit_chars: this.runLimit });
        return;
      }
      this.chars += text.length;
      const parts = Math.max(1, Math.ceil(text.length / 2000));
      for (let part = 0; part < parts; part++)
        this.emit("validation_trace", {
          ...meta,
          part,
          parts,
          offset: part * 2000,
          content: text.slice(part * 2000, (part + 1) * 2000),
        });
    } catch {
      this.emit("model_capture_error", { stage: "validation_trace", kind });
    }
  }
}
