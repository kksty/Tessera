/** Raw HTTP capability probe against configured endpoint; synthetic content only. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { parseModelJson } from "../../packages/runner/src/prompts.js";
import { modelMetadata } from "../../packages/models/src/runtime.js";

const root = resolve(import.meta.dirname, "../..");
const cfg = new RuntimeConfig(join(root, "datas/tessera/runtime.json")).value.model;
const resolved = await modelMetadata(cfg);
if (resolved.api !== "openai-completions") throw new Error("This raw HTTP comparison requires an OpenAI Chat Completions model");
const out = join(root, "test-results", `result-format-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const results: unknown[] = [];
for (let attempt = 1; attempt <= Number(process.env.TESSERA_RESULT_PROBE_REPEAT || 1); attempt++)
for (const stream of [false, true]) for (const json of process.env.TESSERA_RESULT_PROBE_NATIVE_ONLY ? [true] : [false, true]) {
  const at = Date.now();
  const response = await fetch(resolved.base_url + "/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ model: cfg.id, stream, max_tokens: 4096,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: 'Return exactly one valid JSON object with facts [{description,evidence_ids}], findings [] and summary. Do not write Markdown or code fences. Never add unsupported observations.' },
        { role: "user", content: 'Serialize this synthetic already verified result: Evidence e001 says marker FIXTURE-1-AMBER; Evidence e002 says marker FIXTURE-2-AMBER. Return one fact per evidence with its marker and own evidence_ids. summary is 已读取两条合成记录. No tools or target requests are needed.' }] }),
  });
  let text = "", finish: unknown, usage: unknown, frames = 0;
  if (!stream || !response.ok) {
    const body = await response.json() as any;
    if (!response.ok) { results.push({ stream, json, status: response.status, elapsed_ms: Date.now() - at, error_type: body.error?.type ?? null }); continue; }
    text = body.choices?.[0]?.message?.content ?? ""; finish = body.choices?.[0]?.finish_reason; usage = body.usage;
  } else {
    // Parse raw HTTP data independently of Pi/OpenAI SDK; persist public content only.
    const decoder = new TextDecoder(); let pending = "";
    for await (const bytes of response.body!) {
      pending += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        const frame = JSON.parse(line.slice(5)); frames++;
        const choice = frame.choices?.find((c: any) => c.index === 0);
        text += choice?.delta?.content ?? "";
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (frame.usage) usage = frame.usage;
      }
    }
  }
  let valid = false, error: string | null = null;
  try { const parsed = parseModelJson(text); valid = Array.isArray(parsed.facts) && parsed.facts.length === 2; }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  const result = { attempt, stream, json, status: response.status, elapsed_ms: Date.now() - at, finish, usage, frames, valid, error,
    public_body: text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "") };
  results.push(result);
  writeFileSync(join(out, "report.json"), JSON.stringify({ model: cfg.id, results }, null, 2));
  console.log(JSON.stringify({ stream, json, valid, error, elapsed_ms: Date.now() - at, output: (usage as any)?.completion_tokens }));
}
console.log(JSON.stringify({ report: join(out, "report.json") }));
