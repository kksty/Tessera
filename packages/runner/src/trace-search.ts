import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Cross-Run trace search.
 *
 * Every Execute writes `runs/<worker>/tools.ndjson`, one line per tool call with
 * the exact arguments and result. The graph only keeps what the model chose to
 * submit as a Fact, so valuable observations (an error string, a hidden field, a
 * parser quirk) otherwise die with that Run. This module lets a later executor
 * search those processes.
 *
 * A trace is a lead, never Evidence: it has no Evidence ID, no Review and no
 * producer relation. Callers must re-run or read the archived original before
 * turning a hit into a Fact. Output is bounded and redacted because tool
 * arguments can contain cookies, credentials and large binary bodies.
 */

export interface TraceHit {
  run_id: string | null;
  step_id: string | null;
  worker: string;
  kind: string | null;
  tool: string;
  at: string | null;
  matched_in: "tool" | "args" | "result";
  excerpt: string;
  chars: number;
}

export interface TraceSearchOptions {
  excludeRunId?: string;
  excludeWorker?: string;
  limit?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
}

interface TraceLine {
  run_id?: string;
  step_id?: string;
  kind?: string;
  at?: string;
  toolName?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  is_error?: boolean;
}

const MAX_LINE = 2 * 1024 * 1024;

/** Tool arguments/results can carry credentials; never echo them into a model context. */
export function redactTraceText(text: string): string {
  return text
    .replace(
      /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\s*:\s*[^\r\n]*/gi,
      "$1: [redacted]",
    )
    .replace(
      /("?(?:password|passwd|pwd|secret|token|api[_-]?key|session|cookie|authorization)"?\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"[redacted]"',
    )
    .replace(/([?&](?:token|key|password|secret|session)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[base64 omitted]");
}

function excerptAround(text: string, terms: string[], width = 320): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, at - Math.floor(width / 3));
  const slice = text
    .slice(start, start + width)
    .replace(/\s+/g, " ")
    .trim();
  return redactTraceText(`${start > 0 ? "…" : ""}${slice}${start + width < text.length ? "…" : ""}`);
}

function textOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function matches(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

function parse(line: string): TraceLine | null {
  if (!line.trim() || line.length > MAX_LINE) return null;
  try {
    return JSON.parse(line) as TraceLine;
  } catch {
    return null;
  }
}

async function traceFiles(workspace: string, maxFiles: number): Promise<{ worker: string; file: string }[]> {
  const runs = join(workspace, "runs");
  let workers: string[];
  try {
    workers = await readdir(runs);
  } catch {
    return [];
  }
  const files: { worker: string; file: string; mtime: number }[] = [];
  for (const worker of workers) {
    const file = join(runs, worker, "tools.ndjson");
    try {
      const info = await stat(file);
      if (info.isFile()) files.push({ worker, file, mtime: info.mtimeMs });
    } catch {
      // A Run directory without traces is normal (no tool calls).
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxFiles)
    .map(({ worker, file }) => ({ worker, file }));
}

export async function searchWorkerTraces(
  workspace: string,
  query: string,
  options: TraceSearchOptions = {},
): Promise<{ query: string; scanned: number; hits: TraceHit[]; note: string }> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (!terms.length) return { query, scanned: 0, hits: [], note: "query is empty" };
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
  const files = await traceFiles(workspace, options.maxFiles ?? 200);
  const hits: TraceHit[] = [];
  let scanned = 0;
  for (const { worker, file } of files) {
    if (options.excludeWorker && worker === options.excludeWorker) continue;
    let bytes = 0;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line);
        if (bytes > (options.maxBytesPerFile ?? 8 * 1024 * 1024)) break;
        const record = parse(line);
        if (!record) continue;
        // Only execution processes are reusable observations; a Decide/Review
        // Run's tool calls are bookkeeping and would only add noise.
        if (record.kind && record.kind !== "execute" && record.kind !== "peer") continue;
        if (options.excludeRunId && record.run_id === options.excludeRunId) continue;
        const tool = textOf(record.toolName ?? record.tool);
        const args = textOf(record.args);
        const result = textOf(record.result);
        scanned++;
        const inTool = matches(tool, terms);
        const inArgs = !inTool && matches(args, terms);
        const inResult = !inTool && !inArgs && matches(result, terms);
        if (!inTool && !inArgs && !inResult) continue;
        const source = inTool ? tool : inArgs ? args : result;
        hits.push({
          run_id: record.run_id ?? null,
          step_id: record.step_id ?? null,
          worker,
          kind: record.kind ?? null,
          tool: tool.slice(0, 120),
          at: record.at ?? null,
          matched_in: inTool ? "tool" : inArgs ? "args" : "result",
          excerpt: excerptAround(source, terms),
          chars: source.length,
        });
        if (hits.length >= limit * 4) break;
      }
    } catch {
      // A trace being appended or removed mid-scan is not a task failure.
    } finally {
      lines.close();
      stream.destroy();
    }
    if (hits.length >= limit * 4) break;
  }
  hits.sort(
    (a, b) =>
      (a.matched_in === "tool" ? -1 : 0) - (b.matched_in === "tool" ? -1 : 0) || (a.at ?? "").localeCompare(b.at ?? ""),
  );
  return {
    query,
    scanned,
    hits: hits.slice(0, limit),
    note: "过程线索，不是 Evidence：引用前必须自己回读原件或重新复现；不要把其他 Run 的结论直接写成 Fact。",
  };
}

export async function readWorkerTrace(
  workspace: string,
  runId: string,
  toolCallId?: string,
  maxChars = 4000,
): Promise<{
  run_id: string;
  tool_call_id?: string;
  tool: string;
  at: string | null;
  args: string;
  result: string;
  truncated: boolean;
} | null> {
  const files = await traceFiles(workspace, 200);
  for (const { file } of files) {
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const record = parse(line);
        if (!record || record.run_id !== runId) continue;
        const callId =
          (record as TraceLine & { tool_call_id?: string }).tool_call_id ??
          (record as TraceLine & { toolCallId?: string }).toolCallId;
        if (toolCallId && callId !== toolCallId) continue;
        const args = redactTraceText(textOf(record.args));
        const result = redactTraceText(textOf(record.result));
        const budget = Math.max(500, Math.min(maxChars, 12000));
        const argsText = args.slice(0, Math.floor(budget / 3));
        const resultText = result.slice(0, budget - argsText.length);
        return {
          run_id: runId,
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
          tool: textOf(record.toolName ?? record.tool).slice(0, 120),
          at: record.at ?? null,
          args: argsText,
          result: resultText,
          truncated: argsText.length < args.length || resultText.length < result.length,
        };
      }
    } catch {
      // Ignore unreadable or concurrently appended traces.
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return null;
}
