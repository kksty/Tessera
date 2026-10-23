import { commitPlan, recordReview } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  reviewSchema,
} from "../../packages/protocol/src/index.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { Dispatcher } from "../../apps/dispatcher/src/loop.js";
import { parseModelJson } from "../../packages/runner/src/prompts.js";
import { cvss, withImpactEvidence } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import type {
  Graph,
  Job,
  DispatchConfig,
} from "../../packages/protocol/src/index.js";

function removeTemp(dir: string) {
  assert.ok(
    resolve(dir).startsWith(resolve(tmpdir()) + sep) &&
      basename(dir).startsWith("tessera-"),
  );
  rmSync(dir, { recursive: true, force: true });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-node-"));
  const store = new Store(join(dir, "graph.db"));
  const g = store.create(
    createProjectSchema.parse({
      title: "Assessment",
      origin: "https://example.test",
      goal: "Report evidence-backed findings",

    }),
  );
  return {
    store,
    id: g.project.id,
    dir,
    close: () => {
      store.close();
      removeTemp(dir);
    },
  };
}

test("evidence preserves the source file alongside immutable content and hash", () => {
  const f = fixture();
  try {
    const e = f.store.addEvidence(f.id, {
      title: "Original frontend bundle", content: "location.href = target", encoding: "utf8",
      mime_type: "text/javascript", source_path: "/workspace/ybwt/raw/app.123.js",
    });
    const saved = f.store.evidenceContent(f.id, e.id);
    assert.equal(saved.metadata.source_path, "/workspace/ybwt/raw/app.123.js");
    assert.equal(saved.bytes.toString(), "location.href = target");
    assert.match(saved.metadata.sha256, /^[a-f0-9]{64}$/);
    assert.equal(f.store.get(f.id).evidence[0].source_path, saved.metadata.source_path);
  } finally { f.close(); }
});

function decide(
  store: Store,
  id: string,
  changes: Record<string, unknown> = {},
) {
  const job = store.claim(id, "decider", 0);
  assert.equal(job?.kind, "decide");
  const graph = store.get(id);
  return commitPlan(store,
    id,
    decideSchema.parse({
      worker: "decider",
      revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      ...changes,
    }),
  );
}

test("streamed facts are batched until a Step completes; later facts do not postpone that boundary", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  const f = fixture();
  try {
    decide(f.store, f.id, { steps: [
      { from: ["origin"], description: "First batch" },
      { from: ["origin"], description: "Long execution" },
    ] });
    const a = f.store.claim(f.id, "a", 0)!, b = f.store.claim(f.id, "b", 0)!;
    f.store.fact(f.id, a.step_id!, { worker: a.worker, description: "Partial A", evidence_ids: [] });
    t.mock.timers.tick(2000);
    f.store.fact(f.id, b.step_id!, { worker: b.worker, description: "Partial B", evidence_ids: [] });
    assert.equal(f.store.claim(f.id, "planner"), null);
    f.store.execute(f.id, a.step_id!, executeSchema.parse({ worker: a.worker, summary: "Batch finished" }));
    assert.equal(f.store.claim(f.id, "planner"), null, "batch boundary respects debounce");
    t.mock.timers.tick(1000);
    f.store.fact(f.id, b.step_id!, { worker: b.worker, description: "More B", evidence_ids: [] });
    t.mock.timers.tick(500);
    assert.equal(f.store.claim(f.id, "planner")?.kind, "decide", "streaming must not reset the Step boundary clock");
    assert.equal(f.store.get(f.id).facts.length, 4);
  } finally { f.close(); }
});

test("continuous observations have a bounded wait and still allow other execution work", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  const f = fixture();
  try {
    decide(f.store, f.id, { steps: [
      { from: ["origin"], description: "Streaming" },
      { from: ["origin"], description: "Independent" },
    ] });
    const job = f.store.claim(f.id, "executor", 0)!;
    f.store.fact(f.id, job.step_id!, { worker: job.worker, description: "First", evidence_ids: [] });
    const since = f.store.get(f.id).project.decide_pending_since;
    assert.equal(f.store.claim(f.id, "another", 0)?.kind, "execute");
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(5000);
      f.store.fact(f.id, job.step_id!, { worker: job.worker, description: `Partial ${i}`, evidence_ids: [] });
      assert.equal(f.store.claim(f.id, "planner"), null);
      assert.equal(f.store.get(f.id).project.decide_pending_since, since);
    }
    t.mock.timers.tick(5000);
    f.store.fact(f.id, job.step_id!, { worker: job.worker, description: "Still streaming", evidence_ids: [] });
    const planning = f.store.claim(f.id, "planner")!;
    assert.equal(planning.kind, "decide", "dispatch after 30 seconds despite ongoing facts");
    const snapshot = f.store.get(f.id);
    commitPlan(f.store, f.id, decideSchema.parse({ worker: planning.worker, revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision }));
    assert.equal(f.store.claim(f.id, "again"), null, "processed observations do not trigger another Decide");
    assert.equal(f.store.get(f.id).project.decide_pending_since, undefined);
  } finally { f.close(); }
});

test("facts arriving immediately after the 30-second Decide claim remain pending at the same timestamp", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  const f = fixture();
  try {
    decide(f.store, f.id, { steps: [{ from: ["origin"], description: "Streaming at boundary" }] });
    const job = f.store.claim(f.id, "executor", 0)!;
    f.store.fact(f.id, job.step_id!, { worker: job.worker, description: "Before boundary", evidence_ids: [] });
    t.mock.timers.tick(30000);
    const planning = f.store.claim(f.id, "planner", 2000)!;
    assert.equal(planning.kind, "decide");
    const snapshot = f.store.get(f.id);
    // Same clock time, different transaction order and observation revisions.
    f.store.fact(f.id, job.step_id!, { worker: job.worker, description: "Exactly at boundary after claim", evidence_ids: [] });
    commitPlan(f.store, f.id, decideSchema.parse({ worker: planning.worker, revision: snapshot.revision,
      observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision }));
    const after = f.store.get(f.id);
    assert.ok(after.facts.some(fact => fact.description === "Exactly at boundary after claim"));
    assert.ok(after.observation_revision > after.decided_revision);
    assert.ok(after.project.decide_pending_since);
    t.mock.timers.tick(30000);
    assert.equal(f.store.claim(f.id, "next-planner", 2000)?.kind, "decide");
  } finally { f.close(); }
});

test("human hints trigger planning during execution and idle results use the normal debounce", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  const f = fixture();
  try {
    decide(f.store, f.id, { steps: [{ from: ["origin"], description: "Execute" }] });
    const job = f.store.claim(f.id, "executor", 0)!;
    f.store.hint(f.id, "Change direction");
    t.mock.timers.tick(1500);
    const planning = f.store.claim(f.id, "planner")!;
    assert.equal(planning.kind, "decide");
    const snapshot = f.store.get(f.id);
    commitPlan(f.store, f.id, decideSchema.parse({ worker: planning.worker, revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision }));
    f.store.execute(f.id, job.step_id!, executeSchema.parse({ worker: job.worker, facts: ["Final result"] }));
    assert.equal(f.store.claim(f.id, "final-planner"), null);
    t.mock.timers.tick(1500);
    assert.equal(f.store.claim(f.id, "final-planner")?.kind, "decide");
  } finally { f.close(); }
});

test("facts arriving during Decide stay pending in their own batch after a successful stale additive decision", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00Z") });
  const f = fixture();
  try {
    decide(f.store, f.id, { steps: [{ from: ["origin"], description: "Streaming" }] });
    const execution = f.store.claim(f.id, "executor", 0)!;
    f.store.hint(f.id, "Plan another direction");
    const planning = f.store.claim(f.id, "planner", 0)!;
    const snapshot = f.store.get(f.id);
    t.mock.timers.tick(1000);
    f.store.fact(f.id, execution.step_id!, { worker: execution.worker, description: "Arrived during planning", evidence_ids: [] });
    const since = f.store.get(f.id).project.decide_pending_since;
    commitPlan(f.store, f.id, decideSchema.parse({ worker: planning.worker, revision: snapshot.revision, observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision }));
    const result = f.store.get(f.id);
    assert.ok(result.observation_revision > result.decided_revision);
    assert.equal(result.project.decide_pending_since, since);
    assert.equal(f.store.claim(f.id, "next", 0), null);
    t.mock.timers.tick(30000);
    assert.equal(f.store.claim(f.id, "next", 0)?.kind, "decide");
  } finally { f.close(); }
});

test("conflict reporting is durable, lease-bound, idempotent and not an observation or failure", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const before = f.store.get(f.id);
    f.store.release(f.id, { ...job, worker: "other" }, undefined, true);
    assert.equal(f.store.get(f.id).project.decide_conflicts, undefined);
    f.store.release(f.id, job, undefined, true);
    f.store.release(f.id, job, undefined, true);
    const graph = f.store.get(f.id);
    assert.equal(graph.project.decide_conflicts, 1);
    assert.equal(graph.observation_revision, before.observation_revision);
    assert.equal(graph.project.last_error, undefined);
    assert.equal(graph.project.decide_retry_at, undefined);
    const reopened = new Store(join(f.dir, "graph.db"));
    try { assert.equal(reopened.get(f.id).project.decide_conflicts, 1); }
    finally { reopened.close(); }
    assert.equal(f.store.claim(f.id, "next", 0)?.kind, "decide");
  } finally { f.close(); }
});

test("FGS emits multiple facts, retains empty/failed paths, and findings do not finish the project", () => {
  const f = fixture();
  try {
    decide(f.store, f.id, {
      steps: [{ from: ["origin"], description: "Inspect the app" }],
    });
    const job = f.store.claim(f.id, "executor", 0)!;
    assert.equal(job.kind, "execute");
    f.store.fact(f.id, job.step_id!, {
      worker: job.worker,
      description: "First observation",
      evidence_ids: [],
    });
    f.store.execute(
      f.id,
      job.step_id!,
      executeSchema.parse({
        worker: job.worker,
        facts: ["Second observation"],
        summary: "Condition X failed; Y remains unexplored",
      }),
    );
    const graph = f.store.get(f.id);
    assert.equal(graph.steps[0].fact_ids.length, 2);
    assert.equal(
      graph.steps[0].summary,
      "Condition X failed; Y remains unexplored",
    );
    assert.equal(graph.project.status, "active");
  } finally {
    f.close();
  }
});
test("asset discovery never approves; explicit approval is an observation for the decider", () => {
  const f = fixture();
  try {
    decide(f.store, f.id);
    const before = f.store.get(f.id).observation_revision;
    const [asset] = f.store.discover(f.id, [
      { hostname: "API.EXAMPLE.TEST.", source: "discovery", evidence_ids: [] },
    ]);
    assert.equal(asset.hostname, "api.example.test");
    assert.equal(asset.approval, "pending");
    assert.equal(f.store.get(f.id).steps.length, 0);
    assert.ok(f.store.get(f.id).observation_revision > before,
      "discovery is an observation and must reach the next Decide");
    f.store.hint(f.id, "New direction");
    const job = f.store.claim(f.id, "planner", 0)!;
    const graph = f.store.get(f.id);
    assert.throws(
      () =>
        commitPlan(f.store,
          f.id,
          decideSchema.parse({
            worker: job.worker,
            revision: graph.revision,
            observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
            steps: [
              {
                from: ["origin"],
                description: "Test domain",
                asset_id: asset.id,
              },
            ],
          }),
        ),
      /approved/,
    );
    assert.equal(f.store.get(f.id).steps.length, 0);
    f.store.release(f.id, job);
    f.store.approve(f.id, [asset.id]);
    f.store.approve(f.id, [asset.id]);
    f.store.discover(f.id, [
      { hostname: "api.example.test", source: "again", evidence_ids: [] },
    ]);
    let board = f.store.get(f.id);
    assert.equal(board.steps.length, 0, "approval is an observation, not a plan");
    assert.equal(board.assets.find((a) => a.id === asset.id)?.approval, "approved");
    assert.ok(board.facts.some((fact) => fact.description.includes("已批准测试资产")),
      "the decider sees the approval fact");
    // The scheduler now has Decide work; the decider explicitly plans the test.
    const planning = f.store.claim(f.id, "planner-2", 0)!;
    assert.equal(planning.kind, "decide");
    board = f.store.get(f.id);
    commitPlan(f.store, f.id, decideSchema.parse({
      worker: planning.worker, revision: board.revision, observation_revision: board.observation_revision, planning_revision: board.planning_revision,
      steps: [{ from: ["origin"], description: "Test approved asset", asset_id: asset.id }],
    }));
    assert.equal(f.store.get(f.id).steps.length, 1);
  } finally {
    f.close();
  }
});
test("new observations allow additive decisions but cannot be marked as already processed", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const snapshot = f.store.get(f.id);
    f.store.hint(f.id, "New evidence during reasoning");
    commitPlan(f.store,
      f.id,
      decideSchema.parse({
        worker: job.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision,
        steps: [{ from: ["origin"], description: "Explore app" }],
      }),
    );
    const graph = f.store.get(f.id);
    assert.ok(graph.observation_revision > graph.decided_revision);
    assert.equal(f.store.claim(f.id, "next", 0)?.kind, "decide");
  } finally {
    f.close();
  }
});
test("source validation names the id kind so the model can self-correct", () => {
  const f = fixture();
  try {
    const evidence = f.store.addEvidence(f.id, {
      title: "bash tool result",
      content: "nmap output",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    decide(f.store, f.id, {
      steps: [{ from: ["origin"], description: "Collect observations" }],
    });
    const job = f.store.claim(f.id, "executor", 0)!;
    f.store.execute(
      f.id,
      job.step_id!,
      executeSchema.parse({
        worker: job.worker,
        facts: [
          { description: "Ports observed", evidence_ids: [evidence.id] },
        ],
        summary: "observed",
      }),
    );
    const before = f.store.get(f.id);
    const owner = before.facts.find((x) =>
      x.evidence_ids.includes(evidence.id),
    )!;
    // 反向：把事实编号写进 evidence_ids，报错也要点明编号类型
    decide(f.store, f.id, {
      steps: [{ from: ["origin"], description: "Second direction" }],
    });
    const next = f.store.claim(f.id, "executor", 0)!;
    assert.throws(
      () =>
        f.store.execute(
          f.id,
          next.step_id!,
          executeSchema.parse({
            worker: next.worker,
            facts: [{ description: "x", evidence_ids: [owner.id] }],
          }),
        ),
      /事实编号/,
    );
    // 证据编号不能当来源事实：报错要点明编号类型，并给出可用的事实编号
    // （新的 Hint 会唤醒 Decide，这里正好走一次真实的重新规划入口）
    f.store.hint(f.id, "New information: re-plan the directions");
    assert.throws(
      () =>
        decide(f.store, f.id, {
          steps: [{ from: [evidence.id], description: "Bad source" }],
        }),
      new RegExp(`证据编号[\\s\\S]*${owner.id}`),
    );
    const after = f.store.get(f.id);
    assert.equal(after.steps.length, before.steps.length + 1);
    assert.ok(
      after.steps.every((step) => !step.from.includes(evidence.id)),
      "失败的提交不应写入图",
    );
  } finally {
    f.close();
  }
});

test("review records verification advice without planning work and remains version-bound", () => {
  const f = fixture();
  try {
    const e = f.store.addEvidence(f.id, {
      title: "Response",
      content: "Observed response",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const finding = f.store.submitFinding(
      f.id,
      findingSchema.parse({
        title: "Issue",
        description: "Claim",
        from: ["origin"],
        evidence_ids: [e.id],
        status: "confirmed",
      }),
    );
    assert.equal(finding.status, "candidate");
    const job = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(job.kind, "review");
    f.store.review(
      f.id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: 1,
        verdict: "needs_evidence",
        reason: "Need second sample",
        evidence_ids: [e.id],
        verification: "Compare second known sample",
      }),
    );
    assert.equal(f.store.get(f.id).steps.length, 0);
    assert.equal(f.store.get(f.id).reviews[0].verification, "Compare second known sample");
    f.store.submitFinding(
      f.id,
      findingSchema.parse({
        id: finding.id,
        title: "Issue",
        description: "New proof",
        from: ["origin"],
        evidence_ids: [e.id],
      }),
    );
    const job2 = f.store.claim(f.id, "reviewer2", deferDecideMs)!;
    assert.throws(
      () =>
        f.store.review(
          f.id,
          finding.id,
          reviewSchema.parse({ kind: "vulnerability",
            worker: job2.worker,
            finding_version: 1,
            verdict: "pass",
            reason: "Old view",
            evidence_ids: [e.id],
          }),
        ),
      /changed/,
    );
    f.store.review(
      f.id,
      finding.id,
      reviewSchema.parse({
        worker: job2.worker,
        finding_version: 2,
        verdict: "needs_evidence",
        reason: "Still insufficient",
        evidence_ids: [e.id],
        verification: "Do not duplicate verification",
      }),
    );
    assert.equal(f.store.get(f.id).steps.length, 0);
    assert.equal(f.store.get(f.id).findings[0].review_status, "needs_evidence");
    const { bytes, metadata } = f.store.evidenceContent(f.id, e.id);
    assert.equal(bytes.toString(), "Observed response");
    assert.equal(metadata.sha256.length, 64);
  } finally {
    f.close();
  }
});
test("leases prevent duplicate execution and recover after expiry", () => {
  const f = fixture();
  try {
    decide(f.store, f.id, {
      steps: [{ from: ["origin"], description: "One" }],
    });
    const first = f.store.claim(f.id, "a", 0)!;
    assert.equal(f.store.claim(f.id, "b", 0), null);
    f.store.leaseSeconds = -1;
    assert.equal(f.store.claim(f.id, "b", 0), null);
    f.store.mutate(f.id, "", false, g => { g.steps[0].retry_at = new Date(0).toISOString(); });
    const next = f.store.claim(f.id, "b", 0)!;
    assert.equal(next.step_id, first.step_id);
    assert.throws(() => f.store.heartbeat(f.id, first), /lease/);
  } finally {
    f.close();
  }
});
test("project completion waits for unfinished paths and pending reviews", () => {
  const f = fixture();
  try {
    decide(f.store, f.id, {
      steps: [{ from: ["origin"], description: "Unfinished" }],
    });
    f.store.hint(f.id, "Try to complete");
    const job = f.store.claim(f.id, "planner", 0)!;
    const g = f.store.get(f.id);
    assert.throws(
      () =>
        commitPlan(f.store,
          f.id,
          decideSchema.parse({
            worker: job.worker,
            revision: g.revision,
            observation_revision: g.observation_revision, planning_revision: g.planning_revision,
            complete: { from: ["origin"], description: "Finished" },
          }),
        ),
      /remaining steps/,
    );
    assert.equal(f.store.get(f.id).project.status, "active");
  } finally {
    f.close();
  }
});
test("HTTP server + dispatcher + fake backend run the real Decide → Execute → Review → Complete protocol", async () => {
  const f = fixture(),
    runtime = new RuntimeConfig(join(f.dir, "runtime.json"));
  const config: DispatchConfig = {
    ...runtime.value,
    model: {
      ...runtime.value.model,
      id: "mock",
      base_url: "http://mock.invalid",
    },
    max_workers: 1,
    max_project_workers: 1,
    debounce_ms: 0,
  };
  runtime.value = config;
  const app = buildApp(f.store, runtime, join(f.dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ApiClient(app.listeningOrigin, testWorkerToken);
  const backend = {
    async run(job: Job) {
      const g = await client.request<Graph>(client.projectPath(job));
      if (job.kind === "decide") {
        const data = g.findings.length
          ? {
              updates: g.steps.filter((step) => !step.concluded_at).map((step) => ({
                id: step.id,
                expected_version: step.version ?? 1,
                discard: true,
                reason: "Evidence captured; close before completion",
              })),
              complete: {
                from: ["f001"],
                description: "Evidence-backed report delivered",
              },
            }
          : { steps: [{ from: ["origin"], description: "Explore target" }] };
        await client.request(client.projectPath(job, "/fgs/decisions"), {
          submission_id: `plan-${job.run_id}`,
          worker: job.worker,
          revision: g.revision,
          observation_revision: g.observation_revision, planning_revision: g.planning_revision,
          ...data,
        });
      } else if (job.kind === "execute") {
        const e = await client.request<{ id: string }>(
          client.projectPath(job, "/evidence"),
          { title: "proof", content: "reproducible observed result" },
        );
        await client.request(
          client.projectPath(job, `/fgs/steps/${job.step_id}/execute`),
          {
            worker: job.worker,
            facts: ["Verified observation"],
            findings: [
              { ...reportFields, title: "Finding", description: "Impact", evidence_ids: [e.id] },
            ],
          },
        );
      } else
        await client.request(
          client.projectPath(job, `/findings/${job.finding_id}/review`),
          { kind: "vulnerability",
            worker: job.worker,
            finding_version: job.finding_version,
            verdict: "pass",
            reason: "Checked original proof",
            evidence_ids: g.findings[0].evidence_ids,
            cvss: withImpactEvidence(cvss.high, g.findings[0].evidence_ids),
          },
        );
    },
  };
  const dispatcher = new Dispatcher(client, backend);
  try {
    for (
      let i = 0;
      i < 8 && f.store.get(f.id).project.status !== "completed";
      i++
    ) {
      await dispatcher.tick(config);
      await Promise.all([...dispatcher.running.values()].map((t) => t.promise));
    }
    const graph = f.store.get(f.id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.findings[0].status, "confirmed");
    assert.equal(graph.reviews.length, 1);
    const resp = await app.inject({
      method: "GET",
      url: `/api/projects/${f.id}/export?format=findings`,
    });
    assert.equal(resp.statusCode, 200);
    assert.equal(resp.json()[0].status, "confirmed");
    const secret = await app.inject({
      method: "PUT",
      url: "/api/runtime",
      payload: {
        ...runtime.redacted(),
        model: { ...runtime.value.model, api_key: "not-a-real-key" },
      },
    });
    assert.equal(secret.json().model.api_key, "");
    assert.equal(secret.json().model.api_key_set, true);
  } finally {
    await dispatcher.stop();
    await app.close();
    f.close();
  }
});
test("JSON parser accepts fenced responses without confusing quoted braces", () => {
  assert.deepEqual(
    parseModelJson('```json\n{"summary":"a { brace }","facts":[]}\n```'),
    { summary: "a { brace }", facts: [] },
  );
  assert.deepEqual(
    parseModelJson('Result: {"summary":"quoted \\" escape","facts":[]}'),
    { summary: 'quoted " escape', facts: [] },
  );
  assert.throws(() => parseModelJson("not json"), /valid JSON/);
});

test("original manual blackboard controls preserve ownership, multiple source facts and audit history", () => {
  const f = fixture();
  try {
    const s = f.store.manualStep(f.id, {
      from: ["origin"],
      description: "Manual exploration",
      creator: "Human",
      claim: true,
    });
    assert.equal(s.worker, "Human");
    assert.throws(
      () => f.store.manualHeartbeat(f.id, s.id, "Other actor"),
      /another actor/,
    );
    f.store.manualRelease(f.id, s.id, "Human");
    f.store.manualHeartbeat(f.id, s.id, "Human");
    const result = f.store.manualConclude(
      f.id,
      s.id,
      "Human",
      "Observed an entry point",
    );
    const next = f.store.manualStep(f.id, {
      from: ["origin", result.fact.id],
      description: "Compare two observations",
      creator: "Human",
    });
    assert.equal(next.from.length, 2);
    const finding = f.store.submitFinding(
      f.id,
      findingSchema.parse({
        ...reportFields, title: "Human finding",
        description: "Known impact",
        evidence_ids: [f.store.addEvidence(f.id, { title: "Manual proof", content: "Original response", encoding: "utf8", mime_type: "text/plain", source_path: "manual.txt" }).id],
        from: [result.fact.id],
      }),
    );
    f.store.reviseFinding(f.id, finding.id, { cvss: withImpactEvidence(cvss.high, finding.evidence_ids) });
    recordReview(f.store,
      f.id,
      finding.id,
      "confirmed",
      "Human",
      "Independent manual check", "vulnerability",
    );
    assert.equal(f.store.get(f.id).findings[0].review_status, "pass");
    f.store.updateStep(f.id, next.id, {
      discard: true,
      reason: "重复路径，已有其他方向覆盖",
    });
    const discarded = f.store.get(f.id).steps.find((s) => s.id === next.id)!;
    assert.equal(discarded.discarded, true);
    assert.equal(discarded.discard_reason, "重复路径，已有其他方向覆盖");
    f.store.manualComplete(
      f.id,
      [result.fact.id],
      "Human assessment completed",
      "Human",
    );
    assert.equal(f.store.get(f.id).project.status, "completed");
    assert.equal(
      f.store.events(f.id).at(-1)?.kind,
      "project.completed.manually",
    );
  } finally {
    f.close();
  }
});

test("audit-only evidence and usage writes do not invalidate semantic decisions", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "planner", 0)!,
      snapshot = f.store.get(f.id);
    f.store.addEvidence(f.id, {
      title: "Trace",
      content: "Trace data",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    f.store.usage(f.id, job, 100, 20, null);
    commitPlan(f.store,
      f.id,
      decideSchema.parse({
        worker: job.worker,
        revision: snapshot.revision,
        observation_revision: snapshot.observation_revision, planning_revision: snapshot.planning_revision,
        goals: [{ description: "Useful subgoal" }],
      }),
    );
    assert.equal(f.store.get(f.id).goals.length, 2);
  } finally {
    f.close();
  }
});
