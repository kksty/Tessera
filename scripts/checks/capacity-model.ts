/** Isolated Pi long-Execute contract probe. Synthetic history; real summary and compaction. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { configuredModel } from "../../packages/models/src/runtime.js";
import { Type } from "@sinclair/typebox";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { observeModel, type RequestCounters } from "../../packages/runner/src/model-observer.js";
import { parseModelJson, resultRepairPrompt } from "../../packages/runner/src/prompts.js";

const root = resolve(import.meta.dirname, "../..");
const cfg = new RuntimeConfig(join(root, "datas/tessera/runtime.json")).value.model;
assert.ok(cfg.api_key && (cfg.base_url || cfg.provider) && cfg.id);
const dir = mkdtempSync(join(tmpdir(), "tessera-capacity-real-"));
const out = join(root, "test-results", `capacity-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const rows: unknown[] = [];
try {
  const { runtime, model } = await configuredModel({ ...cfg, context_window: 32000, max_output_tokens: 4096 });
  for (const enabled of [false, true]) {
    const work = join(dir, enabled ? "on" : "off"); mkdirSync(work);
    const settings = SettingsManager.inMemory({ compaction: { enabled, reserveTokens: 14000, keepRecentTokens: 3000 }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    const manager = SessionManager.create(work, join(work, "sessions"));
    const old = "Historical proposition: the local fixture needs header X-Fixture-Key: amber-42. The only original is e-old; read it before citing. This is synthetic test data, never a real target or credential.";
    manager.appendMessage({ role: "user", content: old, timestamp: Date.now() - 100000 });
    for (let i = 0; i < 7; i++) {
      manager.appendMessage({ role: "user", content: `Historical unrelated record ${i}: ` + "Routine fixture log: unrelated path unavailable, no confirmed observation; keep the original evidence reference. ".repeat(100), timestamp: Date.now() - 90000 + i });
    }
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical Execute turn ended; finish from original evidence on the next request." }],
      provider: model.provider, model: cfg.id, api: model.api, stopReason: "stop", timestamp: Date.now() - 1000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
    const loader = new DefaultResourceLoader({ cwd: work, agentDir: work, settingsManager: settings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "You are an Execute worker. Use only supplied read-only tools; never contact a target. Preserve original evidence. Return final Execute JSON with facts (description,evidence_ids) and summary. Cite only Evidence actually read." });
    await loader.reload();
    let reads = 0;
    const { session } = await createAgentSession({ cwd: work, agentDir: work, model, modelRuntime: runtime, resourceLoader: loader,
      settingsManager: settings, sessionManager: manager, tools: ["read_evidence"], customTools: [{ name: "read_evidence", label: "read_evidence",
        description: "Read an existing original Evidence record by id.", parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, args) => {
          assert.deepEqual(args, { id: "e-old" }); reads++;
          return { content: [{ type: "text", text: JSON.stringify({ id: "e-old", original: "The synthetic fixture requires header X-Fixture-Key: amber-42." }) }], details: {} };
        } }] });
    const events: unknown[] = [], usage: { request_id: string; purpose: string; counters: RequestCounters }[] = [];
    let summary = false; const phases = new Map<string, string>();
    session.subscribe(e => {
      if (e.type === "compaction_start") { summary = true; events.push({ type: e.type, reason: e.reason, usage: session.getContextUsage() }); }
      if (e.type === "compaction_end") { summary = false; events.push({ type: e.type, error: e.errorMessage, aborted: e.aborted, usage: session.getContextUsage(), before: e.result?.tokensBefore, after: e.result?.estimatedTokensAfter }); }
    });
    const observer = observeModel(session.agent.streamFunction, { directory: work, secrets: [cfg.api_key],
      start: id => phases.set(id, summary ? "compaction" : "task"),
      complete: (id, counters) => usage.push({ request_id: id, purpose: phases.get(id)!, counters }),
      failure: () => { throw new Error("Response capture failed"); } });
    session.agent.streamFunction = observer.stream;
    const start = Date.now(), timer = setTimeout(() => void session.abort(), 180000);
    try {
      await session.prompt("Finish this synthetic Execute: use read_evidence(e-old) to verify the historical header precondition. Return final Execute JSON describing the exact header and value with evidence_ids [e-old]. Do not repeat unrelated history or perform any other work.");
      let final: Record<string, unknown>, formatError: string | undefined;
      try { final = parseModelJson(session.getLastAssistantText()!); }
      catch (error) {
        formatError = error instanceof Error ? error.message : String(error);
        await session.prompt(resultRepairPrompt({ kind: "execute" } as any, formatError));
        final = parseModelJson(session.getLastAssistantText()!);
      }
      assert.ok(reads > 0); assert.match(JSON.stringify(final), /amber-42/);
      assert.ok((final.facts as any[]).some(f => f.evidence_ids.includes("e-old")));
      if (enabled) assert.ok(events.some((e: any) => e.type === "compaction_end" && e.after < e.before));
      rows.push({ enabled, elapsed_ms: Date.now() - start, reads, usage, events, final, format_error_before_repair: formatError ?? null, cost: null, current: session.getContextUsage() });
      writeFileSync(join(out, enabled ? "on-responses.ndjson" : "off-responses.ndjson"), readFileSync(join(work, "model-responses.ndjson")));
      console.log(JSON.stringify({ enabled, requests: usage.length, summary_requests: usage.filter(u => u.purpose === "compaction").length, elapsed_ms: Date.now() - start, evidence_read: true }));
    } catch (error) {
      const failure = { enabled, error: error instanceof Error ? error.message : String(error), usage, events, last: session.getLastAssistantText(), current: session.getContextUsage() };
      writeFileSync(join(out, "failure.json"), JSON.stringify(failure, null, 2));
      writeFileSync(join(out, enabled ? "on-responses.ndjson" : "off-responses.ndjson"), readFileSync(join(work, "model-responses.ndjson")));
      throw error;
    } finally { clearTimeout(timer); session.dispose(); }
  }
  const report = { at: new Date().toISOString(), model: cfg.id, sdk: "1.2.0", configured_window: cfg.context_window, experiment_window: 32000,
    boundary: "Synthetic long history; actual provider summary and compaction; standalone Pi using the runner observer, not deployed project or natural long-task coverage", rows };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: "passed", report: join(out, "report.json") }));
} finally { rmSync(dir, { recursive: true, force: true }); }
