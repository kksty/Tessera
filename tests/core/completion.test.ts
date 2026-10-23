import { commitPlan } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { internalToken, validInternalToken } from "../../packages/protocol/src/internal-auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { parseModelJson } from "../../packages/runner/src/prompts.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { ApiClient, ApiError } from "../../packages/runner/src/client.js";

function fixture(lease = 120) {
  const dir = mkdtempSync(join(tmpdir(), "tessera-completion-")), file = join(dir, "graph.db");
  let store = new Store(file, lease);
  if (lease !== 120) store.setSettings({ intent_timeout: lease, reason_timeout: lease });
  const graph = store.create(createProjectSchema.parse({ title: "Completion fixture", origin: "https://example.test", goal: "Assess" }));
  const plan = store.claim(graph.project.id, "planner", 0)!, snapshot = store.get(graph.project.id);
  commitPlan(store, graph.project.id, decideSchema.parse({ worker: plan.worker, revision: snapshot.revision,
    observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision, steps: [{ from: ["origin"], description: "Inspect one question" }] }));
  const job = store.claim(graph.project.id, "executor", 0)!;
  return { dir, file, id: graph.project.id, job, get store() { return store; },
    restart: () => { store.close(); store = new Store(file, lease); },
    close: () => { store.close(); assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith("tessera-completion-")); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("internal configuration is authenticated even when no environment token was configured", async () => {
  const f = fixture(), runtime = new RuntimeConfig(join(f.dir, "runtime.json"));
  runtime.value.model.api_key = "fixture-secret";
  const app = buildApp(f.store, runtime, join(f.dir, "no-web"), "fixture-token", { auth: false });
  try {
    for (const headers of [undefined, { "x-tessera-worker-token": "" }, { "x-tessera-worker-token": "wrong" }]) {
      const response = await app.inject({ method: "GET", url: "/api/runtime/config", headers });
      assert.equal(response.statusCode, 403); assert.ok(!response.body.includes("fixture-secret"));
    }
    const dispatchConfig = await app.inject({ method: "GET", url: "/api/runtime/config", headers: { "x-tessera-worker-token": "fixture-token" } });
    assert.equal(dispatchConfig.json().model.api_key, "");
    assert.ok(!dispatchConfig.body.includes("fixture-secret"));
    assert.equal((await app.inject({ method: "GET", url: "/api/runtime" })).json().model.api_key, "");
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${f.id}/jobs/claim`, payload: { worker: "unknown" } })).statusCode, 403);
  } finally { await app.close(); f.close(); }
});

test("automatic internal credentials persist and empty credentials never authenticate", () => {
  const f = fixture(), original = process.env.TESSERA_WORKER_TOKEN;
  try {
    delete process.env.TESSERA_WORKER_TOKEN;
    const file = join(f.dir, "credential"), token = internalToken(file);
    assert.match(token, /^[0-9a-f]{64}$/); assert.equal(internalToken(file), token);
    assert.ok(validInternalToken(token, token)); assert.equal(validInternalToken("", ""), false);
    assert.equal(validInternalToken(token, [token]), false);
    writeFileSync(file, ""); assert.throws(() => internalToken(file), /empty/);
  } finally { if (original === undefined) delete process.env.TESSERA_WORKER_TOKEN; else process.env.TESSERA_WORKER_TOKEN = original; f.close(); }
});

test("Run session and action records persist without changing the observation revision", () => {
  const f = fixture();
  try {
    const revision = f.store.get(f.id).observation_revision;
    f.store.runStarted(f.id, f.job, "/workspace/sessions/original.jsonl");
    f.store.externalAction(f.id, f.job); f.store.heartbeat(f.id, f.job);
    assert.equal(f.store.get(f.id).observation_revision, revision);
    f.restart();
    const run = f.store.runs(f.id).find(r => r.id === f.job.run_id)!;
    assert.equal(run.session_path, "/workspace/sessions/original.jsonl"); assert.equal(run.external_action_possible, true);
    f.store.execute(f.id, f.job.step_id!, executeSchema.parse({ worker: f.job.worker, summary: "Completed" }));
    assert.equal(f.store.runs(f.id)[0].status, "succeeded");
    assert.ok(f.store.runs(f.id)[0].finished_at);
  } finally { f.close(); }
});

test("uncertain execution blocks automatic and legacy claims until explicit current-run confirmation", () => {
  const f = fixture();
  try {
    f.store.externalAction(f.id, f.job); f.store.release(f.id, f.job, "Connection lost after shell permission");
    assert.equal(f.store.runs(f.id)[0].status, "needs_attention");
    assert.equal(f.store.get(f.id).steps[0].blocked_run_id, f.job.run_id);
    const planner = f.store.claim(f.id, "replanner", 0)!;
    assert.equal(planner.kind, "decide");
    const g = f.store.get(f.id);
    commitPlan(f.store, f.id, decideSchema.parse({ worker: planner.worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision }));
    assert.equal(f.store.claim(f.id, "automatic-retry", 0), null);
    assert.throws(() => f.store.manualHeartbeat(f.id, f.job.step_id!, "manual"), /inspection/);
    f.restart(); assert.equal(f.store.claim(f.id, "after-restart", 0), null);
    assert.throws(() => f.store.retryRun(f.id, "unknown"), /not found/);
    f.store.retryRun(f.id, f.job.run_id!);
    const planning = f.store.claim(f.id, "after-confirmation-planner", 0)!;
    if (planning.kind === "decide") {
      const state = f.store.get(f.id); commitPlan(f.store, f.id, decideSchema.parse({ worker: planning.worker, revision: state.revision, observation_revision: state.observation_revision, planning_revision: state.planning_revision }));
    }
    const retry = planning.kind === "execute" ? planning : f.store.claim(f.id, "confirmed-retry", 0)!;
    assert.equal(retry.kind, "execute"); assert.notEqual(retry.run_id, f.job.run_id);
    assert.equal(f.store.runs(f.id).find(r => r.id === retry.run_id)!.attempt, 2);
    assert.throws(() => f.store.retryRun(f.id, f.job.run_id!), /current blocked/);
  } finally { f.close(); }
});

test("lease expiry preserves uncertain actions while action-free attempts may be retried", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  for (const action of [false, true]) {
    const f = fixture(1);
    try {
      if (action) f.store.externalAction(f.id, f.job);
      t.mock.timers.tick(1001);
      const next = f.store.claim(f.id, "after-expiry", 0);
      assert.equal(next, null);
      t.mock.timers.tick(5001);
      const resumed = f.store.claim(f.id, "after-backoff", 0);
      assert.equal(resumed?.kind || null, action ? "decide" : "execute");
      if (action) {
        const read = f.store.get(f.id);
        commitPlan(f.store, f.id, decideSchema.parse({ worker: resumed!.worker, revision: read.revision,
          observation_revision: read.observation_revision, planning_revision: read.planning_revision }));
        assert.equal(f.store.claim(f.id, "blocked-retry", 0), null);
      }
      assert.equal(f.store.runs(f.id).find(r => r.id === f.job.run_id)!.status, action ? "needs_attention" : "interrupted");
    } finally { f.close(); }
  }
});

test("old Attempt cannot release a newer lease even when a worker name is reused", () => {
  const f = fixture();
  try {
    f.store.release(f.id, f.job);
    const next = f.store.claim(f.id, f.job.worker, 0)!;
    assert.notEqual(next.run_id, f.job.run_id);
    assert.throws(() => f.store.heartbeat(f.id, f.job), /lease lost/);
    f.store.release(f.id, f.job, "Model provider failure: quota exhausted");
    assert.equal(f.store.get(f.id).project.status, "active");
    assert.equal(f.store.get(f.id).steps[0].run_id, next.run_id);
    assert.equal(f.store.runs(f.id)[0].status, "running");
    assert.throws(() => f.store.externalAction(f.id, { ...next, project_id: "other-project" }), /does not match/);
  } finally { f.close(); }
});

test("incremental and final receipts survive restart and reject changed content", () => {
  const f = fixture();
  try {
    const body = { worker: f.job.worker, description: "Original observation", evidence_ids: [] };
    const fact = f.store.submit(f.id, "fact", "one", body, () => f.store.fact(f.id, f.job.step_id!, body)) as { id: string };
    const final = executeSchema.parse({ worker: f.job.worker, summary: "Done" });
    const ack = f.store.submit(f.id, "execute", "finish", final, () => f.store.execute(f.id, f.job.step_id!, final));
    f.restart();
    assert.deepEqual(f.store.submit(f.id, "fact", "one", body, () => { throw new Error("must not execute again"); }), fact);
    assert.deepEqual(f.store.submit(f.id, "execute", "finish", final, () => { throw new Error("must not conclude again"); }), ack);
    assert.equal(f.store.get(f.id).steps[0].fact_ids.length, 1);
    assert.throws(() => f.store.submit(f.id, "fact", "one", { ...body, description: "Different" }, () => {}), /different content/);
    assert.equal(f.store.runs(f.id)[0].status, "succeeded");
  } finally { f.close(); }
});

test("failed business writes roll back both graph and receipt; stale Decide conflicts remain conflicts", () => {
  const f = fixture();
  try {
    const revision = f.store.get(f.id).revision;
    const bad = executeSchema.parse({ worker: f.job.worker, facts: [{ description: "First", evidence_ids: [] }, { description: "Bad", evidence_ids: ["e999"] }] });
    assert.throws(() => f.store.submit(f.id, "execute", "bad", bad, () => f.store.execute(f.id, f.job.step_id!, bad)), /evidence/);
    assert.equal(f.store.execution.receipt(f.id, "execute", "bad"), undefined);
    assert.equal(f.store.get(f.id).revision, revision); assert.equal(f.store.get(f.id).facts.length, 1);
    f.store.hint(f.id, "New information");
    const job = f.store.claim(f.id, "planner2", 0)!, g = f.store.get(f.id);
    f.store.hint(f.id, "Arrived after snapshot");
    const stale = decideSchema.parse({ worker: job.worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision,
      complete: { from: ["origin"], description: "Stale completion" } });
    assert.throws(() => f.store.submit(f.id, "decide", "stale", stale, () => commitPlan(f.store, f.id, stale)), /Graph changed|remaining steps/);
    assert.equal(f.store.execution.receipt(f.id, "decide", "stale"), undefined);
    f.store.release(f.id, job, undefined, true);
    assert.equal(f.store.claim(f.id, "fresh-planner", 0)?.kind, "decide");
  } finally { f.close(); }
});

test("HTTP client replays an accepted submission after its response is lost and never retries semantic 409", async () => {
  const f = fixture(), app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json")), join(f.dir, "no-web"), "fixture-token", { auth: false });
  let calls = 0;
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.endsWith("/facts") && ++calls === 1) reply.raw.destroy();
    return payload;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ApiClient(app.listeningOrigin, "fixture-token"), route = client.projectPath(f.job, `/fgs/steps/${f.job.step_id}/facts`);
  const body = { worker: f.job.worker, description: "One committed observation", evidence_ids: [] };
  try {
    const result = await client.commit<{id:string}>(route, body, f.job.run_id, "response-lost");
    assert.equal(calls, 2); assert.equal(f.store.get(f.id).steps[0].fact_ids.length, 1);
    f.store.execute(f.id, f.job.step_id!, executeSchema.parse({ worker: f.job.worker }));
    assert.equal((await client.commit<{id:string}>(route, body, f.job.run_id, "response-lost")).id, result.id);
    const previous = calls;
    await assert.rejects(client.commit(route, { ...body, description: "Changed" }, f.job.run_id, "response-lost"), e => e instanceof ApiError && e.status === 409);
    assert.equal(calls, previous + 1);
  } finally { await app.close(); f.close(); }
});

test("request accounting deduplicates, accepts late counters and does not clear model backoff", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "", false, g => { g.project.model_failures = 2; g.project.model_retry_at = "2099-01-01T00:00:00Z"; });
    const observation = f.store.get(f.id).observation_revision;
    f.store.usage(f.id, f.job, null, null, null, "r1", "started");
    assert.equal(f.store.get(f.id).observation_revision, observation);
    f.store.release(f.id, f.job, "Malformed result");
    const failedObservation = f.store.get(f.id).observation_revision;
    const first = f.store.usage(f.id, f.job, 120, 30, null, "r1");
    assert.deepEqual(f.store.usage(f.id, f.job, 120, 30, null, "r1"), first);
    assert.throws(() => f.store.usage(f.id, f.job, 121, 30, null, "r1"), /different completed/);
    const g = f.store.get(f.id), run = f.store.runs(f.id)[0];
    assert.equal(g.usage.length, 1); assert.equal(run.request_count, 1); assert.equal(run.input, 120); assert.equal(run.output, 30);
    assert.equal(run.unknown_request_count, 0); assert.equal(run.cost, null);
    assert.equal(g.project.model_failures, 2); assert.equal(g.project.model_retry_at, "2099-01-01T00:00:00Z");
    assert.equal(g.observation_revision, failedObservation, "usage does not change observations");
  } finally { f.close(); }
});

test("structured findings keep unknown fields, normalize identities and requeue review on meaningful revisions", () => {
  const f = fixture();
  try {
    const evidence = f.store.addEvidence(f.id, { title: "Proof", content: "Original proof", encoding: "utf8", mime_type: "text/plain" });
    const identity = { category: "Custom Logic", host: "Example.TEST.", protocol: "HTTPS", method: "get", path: "/Private", parameter: "id" };
    const first = f.store.submitFinding(f.id, findingSchema.parse({ title: "First", description: "Observed impact", evidence_ids: [evidence.id], from: ["origin"],
      identity, severity: "high", severity_reason: "Cross-user data disclosure", impact: "Another account's record", reproduction: { conditions: ["Two accounts"], steps: ["Use the second account's id"], observed: "Response contains its record" }, remediation: "Authorize object access" }));
    const second = f.store.submitFinding(f.id, findingSchema.parse({ title: "Different title", description: "Same identity", identity: { ...identity, host: "example.test", protocol: "https", port: 443, method: "GET" } }));
    assert.deepEqual(f.store.duplicateFindings(f.id)[0].finding_ids, [first.id, second.id]);
    assert.equal(second.severity, null);
    assert.equal(first.identity!.host, "example.test");
    const review = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    f.store.review(f.id, first.id, reviewSchema.parse({ kind: "vulnerability", worker: review.worker, finding_version: first.version, verdict: "pass", reason: "Original evidence inspected", evidence_ids: [evidence.id], cvss: cvss.high }));
    const revised = f.store.reviseFinding(f.id, first.id, { severity: "medium" });
    assert.equal(revised.version, 2); assert.equal(revised.review_status, "pending"); assert.equal(revised.impact, "Another account's record");
    const same = f.store.reviseFinding(f.id, first.id, { severity: "medium" }); assert.equal(same.version, 2);
    assert.throws(() => findingSchema.parse({ title: "Bad", description: "Bad", identity: { category: "x", host: "a", port: 99999, path: "/" } }));
    assert.throws(() => findingSchema.parse({ title: "Bad", description: "Bad", identity: { category: "x", host: "a" } }));
  } finally { f.close(); }
});

function readZip(file: string): Record<string, string> {
  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead('${file.replace(/'/g, "''")}'); $entries = @{}; try { foreach ($entry in $archive.Entries) { $stream = $entry.Open(); $memory = [System.IO.MemoryStream]::new(); try { $stream.CopyTo($memory); $entries[$entry.FullName] = [Convert]::ToBase64String($memory.ToArray()) } finally { $stream.Dispose(); $memory.Dispose() } }; $entries | ConvertTo-Json -Compress } finally { $archive.Dispose() }`;
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ProgressPreference = 'SilentlyContinue'; " + script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }));
  }
  execFileSync("unzip", ["-t", file]);
  const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
  return Object.fromEntries(names.map(name => [name, execFileSync("unzip", ["-p", file, name]).toString("base64")]));
}

test("report snapshots freeze current passing versions and interoperable evidence ZIPs verify original bytes", () => {
  const f = fixture();
  try {
    const proof = "HTTP/1.1 200 OK\n原始证据", evidence = f.store.addEvidence(f.id, { title: "Original HTTP", content: proof, encoding: "utf8", mime_type: "text/plain" });
    const finding = f.store.submitFinding(f.id, findingSchema.parse({ ...reportFields, title: "Verified finding", description: "Evidence-backed claim", from: ["origin"], evidence_ids: [evidence.id], severity: "high", impact: "Observed impact" }));
    f.store.submitFinding(f.id, findingSchema.parse({ title: "Pending", description: "Not verified" }));
    const review = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    f.store.review(f.id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: review.worker, finding_version: finding.version, verdict: "pass", reason: "Checked original response", evidence_ids: [evidence.id], cvss: cvss.high }));
    let reports = new Reports(f.store); const snapshot = reports.create(f.id), markdown = reports.markdown(snapshot);
    assert.equal(snapshot.material.findings.length, 1); assert.equal(snapshot.material.excluded.pending, 1);
    assert.ok(markdown.includes("Observed impact")); assert.ok(!markdown.includes("## v002"));
    assert.ok(markdown.includes(evidence.sha256)); assert.equal(reports.list(f.id)[0].stale, false);
    f.store.usage(f.id, f.job, 12, 3, null, "account-only"); assert.equal(reports.list(f.id)[0].stale, false);
    const file = join(f.dir, "report.zip"); writeFileSync(file, reports.archive(snapshot));
    const archive = readZip(file);
    assert.equal(Buffer.from(archive[`evidence/${evidence.id}.txt`], "base64").toString(), proof);
    assert.equal(Buffer.from(archive["report.md"], "base64").toString(), markdown);
    assert.equal(JSON.parse(Buffer.from(archive["manifest.json"], "base64").toString()).source_hash, snapshot.source_hash);
    f.store.reviseFinding(f.id, finding.id, { impact: "Revised impact" }); assert.equal(reports.list(f.id)[0].stale, true);
    f.restart(); reports = new Reports(f.store); assert.equal(reports.get(f.id, snapshot.id).source_hash, snapshot.source_hash);
    assert.equal(reports.markdown(reports.get(f.id, snapshot.id)), markdown);
    const record = f.store.get(f.id).evidence[0]; writeFileSync(join(f.store.evidenceRoot, f.id, record.id), "tampered");
    assert.throws(() => reports.archive(snapshot), /integrity changed/);
  } finally { f.close(); }
});

test("strict result parsing rejects duplicate keys and damaged outer envelopes without salvaging children", () => {
  for (const raw of ['{"facts":[],"facts":["invented"]}', '{"outer":{"summary":"nested"}', '{} {}', '```json\n{"facts":[]}'])
    assert.throws(() => parseModelJson(raw));
  assert.deepEqual(parseModelJson('Result: {"summary":"a } inside a string", "facts":[]}'), { summary: "a } inside a string", facts: [] });
});
