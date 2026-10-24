import { commitPlan, recordReview } from "../helpers/current-api.js";
import { deferDecideMs } from "../helpers/scheduling.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import { createProjectSchema, findingSchema, evidenceSchema, decideSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema, trafficStatusSchema } from "../../packages/protocol/src/traffic.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { saveEvidenceFile } from "../../packages/runner/src/evidence-file.js";
import { DockerBackend, workerCommand } from "../../apps/dispatcher/src/docker.js";
import { Dispatcher } from "../../apps/dispatcher/src/loop.js";
import { cvss, withImpactEvidence } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-audit-fix-")),
    store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Audit regression", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  return {
    dir,
    store,
    id,
    close: () => {
      store.close();
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const proof = (store: Store, id: string) =>
  store.addEvidence(id, evidenceSchema.parse({ title: "Original proof", content: "raw response" }));

test("parsed incremental revisions preserve omitted provenance and require evidence for manual confirmation", () => {
  const f = fixture();
  try {
    const step = f.store.manualStep(f.id, { from: ["origin"], description: "Inspect", creator: "human", claim: true });
    const evidence = proof(f.store, f.id);
    const first = f.store.submitStepFinding(
      f.id,
      step.id,
      "human",
      findingSchema.parse({
        ...reportFields,
        title: "Claim",
        description: "Original",
        from: ["origin"],
        evidence_ids: [evidence.id],
        evidence: "Proof context",
      }),
    );
    const second = f.store.submitStepFinding(
      f.id,
      step.id,
      "human",
      findingSchema.parse({ id: first.id, title: "Updated", description: "Updated details" }),
    );
    assert.deepEqual(second.from, ["origin"]);
    assert.deepEqual(second.evidence_ids, [evidence.id]);
    assert.equal(second.evidence, "Proof context");
    assert.equal(second.created_at, first.created_at);
    assert.equal(second.step_id, step.id);
    assert.equal(second.version, 2);
    assert.equal(second.review_status, "pending");
    const empty = f.store.submitFinding(f.id, findingSchema.parse({ title: "No proof", description: "Narrative" }));
    assert.throws(
      () => recordReview(f.store, f.id, empty.id, "confirmed", "human", "Checked", "vulnerability"),
      /referenced evidence/,
    );
    f.store.mutate(f.id, "", false, (g) => {
      const v = g.findings.find((v) => v.id === empty.id)!;
      v.status = "confirmed";
      v.review_status = "pass";
      v.reviewed_version = v.version;
    });
    assert.equal(reportMaterial(f.store.get(f.id)).findings.length, 0, "historical invalid pass must not enter report");
    f.store.reviseFinding(f.id, first.id, { cvss: withImpactEvidence(cvss.high, [evidence.id]) });
    recordReview(f.store, f.id, first.id, "confirmed", "human", "Read original", "vulnerability");
    assert.equal(reportMaterial(f.store.get(f.id)).findings.length, 1);
  } finally {
    f.close();
  }
});

test("revoked scope remains available to archival completion while fresh testing stays blocked", () => {
  const f = fixture();
  try {
    f.store.revokeAssets(f.id, ["a001"]);
    assert.throws(
      () => f.store.manualStep(f.id, { from: ["origin"], description: "New test", creator: "human" }),
      /approved/,
    );
    const planner = f.store.claim(f.id, "planner", 0)!,
      g = f.store.get(f.id);
    commitPlan(
      f.store,
      f.id,
      decideSchema.parse({
        worker: planner.worker,
        revision: g.revision,
        observation_revision: g.observation_revision,
        planning_revision: g.planning_revision,
        complete: { from: ["origin"], description: "Scope withdrawn" },
      }),
    );
    assert.equal(f.store.get(f.id).project.status, "completed");
  } finally {
    f.close();
  }
});

test("generic failures back off, yield runnable steps and stop after three failures", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T00:00:00Z") });
  const f = fixture();
  try {
    const first = f.store.claim(f.id, "planner", 0)!;
    f.store.release(f.id, first, "Malformed result");
    f.store.manualStep(f.id, { from: ["origin"], description: "Runnable", creator: "human" });
    // Execute may fill a slot while Decide is still in its retry backoff.
    const execution = f.store.claim(f.id, "executor", 0)!;
    assert.equal(execution.kind, "execute");
    f.store.release(f.id, execution);
    f.store.mutate(f.id, "", false, (g) => {
      g.steps[0].discarded = true;
      g.steps[0].concluded_at = new Date().toISOString();
    });
    t.mock.timers.tick(5001);
    for (let i = 0; i < 2; i++) {
      const job = f.store.claim(f.id, `planner-${i}`, 0)!;
      assert.equal(job.kind, "decide");
      f.store.release(f.id, job, "Malformed result");
      t.mock.timers.tick(20001);
    }
    assert.equal(f.store.get(f.id).project.status, "stopped");
    assert.equal(f.store.claim(f.id, "later", 0), null, "a paused project has no claimable work");
    assert.ok(f.store.runs(f.id).every((r) => r.status !== "running"));
  } finally {
    f.close();
  }
});

test("public model settings omit infrastructure and empty configuration cannot start or claim jobs", async () => {
  const f = fixture(),
    runtime = new RuntimeConfig(join(f.dir, "runtime.json"));
  runtime.value.model = { ...runtime.value.model, id: "", base_url: "" };
  const app = buildApp(f.store, runtime, join(f.dir, "no-web"));
  try {
    const config = (await app.inject({ url: "/api/runtime" })).json();
    for (const key of ["server", "worker_image", "network", "volume_prefix"]) assert.equal(config[key], undefined);
    assert.equal((await app.inject({ method: "PUT", url: "/api/runtime", payload: config })).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "PUT", url: "/api/runtime", payload: { ...config, network: "other" } })).statusCode,
      422,
    );
    f.store.status(f.id, "stopped");
    const status = await app.inject({
      method: "PUT",
      url: `/api/projects/${f.id}/status`,
      payload: { status: "active" },
    });
    assert.equal(status.statusCode, 422);
    assert.match(status.body, /API 地址/);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${f.id}/jobs/claim`,
          headers: { "x-tessera-worker-token": testWorkerToken },
          payload: { worker: "worker" },
        })
      ).statusCode,
      422,
    );
    runtime.value.model.base_url = "http://localhost:8080/v1";
    assert.match(
      (await app.inject({ method: "PUT", url: `/api/projects/${f.id}/status`, payload: { status: "active" } })).body,
      /选择模型/,
    );
    runtime.value.model.id = "explicit-model";
    assert.equal(
      (await app.inject({ method: "PUT", url: `/api/projects/${f.id}/status`, payload: { status: "active" } }))
        .statusCode,
      200,
    );
    assert.equal(runtime.value.network, "tessera-network");
  } finally {
    await app.close();
    f.close();
  }
});

test("web report API returns an immutable snapshot after its project inputs change", async () => {
  const f = fixture(),
    app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json")), join(f.dir, "no-web"));
  try {
    const snapshot = (await app.inject({ method: "POST", url: `/api/projects/${f.id}/reports`, payload: {} })).json();
    f.store.rename(f.id, "Later title");
    const response = await app.inject({ url: `/api/projects/${f.id}/reports/${snapshot.id}` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), snapshot);
    assert.equal((await app.inject({ url: `/api/projects/${f.id}/reports` })).json()[0].stale, true);
    assert.equal((await app.inject({ url: `/api/projects/${f.id}/reports/missing` })).statusCode, 404);
  } finally {
    await app.close();
    f.close();
  }
});

test("large evidence uploads preserve all original bytes and include report parts", async () => {
  const f = fixture();
  try {
    const original = Buffer.alloc(21 * 1024 * 1024, 0xa7),
      file = join(f.dir, "large.bin");
    writeFileSync(file, original);
    let maximum = 0;
    const manifest = await saveEvidenceFile(
      file,
      { title: "Large binary", mime_type: "application/octet-stream" },
      async (body) => {
        maximum = Math.max(maximum, String(body.content).length);
        return f.store.addEvidence(f.id, evidenceSchema.parse(body));
      },
    );
    assert.ok(maximum < 20_000_000);
    assert.equal(manifest.part_ids?.length, 3);
    const data = JSON.parse(f.store.evidenceContent(f.id, manifest.id).bytes.toString());
    assert.equal(data.size, original.length);
    const reconstructed = Buffer.concat(manifest.part_ids!.map((id) => f.store.evidenceContent(f.id, id).bytes));
    assert.ok(reconstructed.equals(original));
    const finding = f.store.submitFinding(
      f.id,
      findingSchema.parse({
        ...reportFields,
        title: "Large proof",
        description: "Verified",
        evidence_ids: [manifest.id],
      }),
    );
    f.store.reviseFinding(f.id, finding.id, { cvss: withImpactEvidence(cvss.high, [manifest.id]) });
    recordReview(f.store, f.id, finding.id, "confirmed", "human", "Read parts", "vulnerability");
    const reports = new Reports(f.store),
      report = reports.create(f.id);
    assert.equal(report.material.evidence.length, 4);
    assert.equal(reports.archive(report).subarray(0, 2).toString(), "PK");
    const directory = join(f.store.evidenceRoot, f.id);
    assert.ok(existsSync(directory));
    f.store.remove(f.id);
    assert.equal(existsSync(directory), false);
    f.store.maintenance();
  } finally {
    f.close();
  }
});

test("traffic counts actual writes and searches percent and underscore literally", () => {
  const f = fixture();
  try {
    const row = trafficRecordSchema.parse({
      id: "flow",
      created_at: new Date().toISOString(),
      method: "GET",
      url: "https://example.test/a_%25",
      host: "example.test",
      protocol: "HTTP/1.1",
      request: { head: "GET /a_%25 HTTP/1.1", body_base64: "", size: 0, truncated: false },
    });
    assert.equal(f.store.traffic.ingest(f.id, [row]).accepted, 1);
    const updated = f.store.traffic.get(f.id, row.id)!.updated_at;
    assert.equal(f.store.traffic.ingest(f.id, [row]).accepted, 0);
    assert.equal(f.store.traffic.get(f.id, row.id)!.updated_at, updated);
    assert.equal(f.store.traffic.list(f.id, 0, 200, "_%25").length, 1);
    assert.equal(f.store.traffic.list(f.id, 0, 200, "missing_%").length, 0);
    const totals = f.store.db.prepare("SELECT count,bytes FROM project_traffic_totals WHERE project_id=?").get(f.id)!;
    assert.equal(totals.count, 1);
    assert.ok(Number(totals.bytes) > 0);
  } finally {
    f.close();
  }
});

test("traffic status accepts a TLS downgrade notice", () => {
  const status = trafficStatusSchema.parse({ state: "degraded", tls_notice: "TLS 1.2 握手失败" });
  assert.equal(status.tls_notice, "TLS 1.2 握手失败");
  assert.equal(trafficStatusSchema.safeParse({ state: "degraded", tls_notice: 1 }).success, false);
});

test("worker refresh compares image IDs, drains active work and retains volumes", async () => {
  const backend = new DockerBackend();
  let stopped = 0,
    removed = 0,
    missing = false,
    options: unknown;
  (backend as any).docker = {
    getImage: () => ({
      inspect: async () => {
        if (missing) throw new Error("Image missing");
        return { Id: "new" };
      },
    }),
    getContainer: () => ({
      inspect: async () => ({ Image: "old", State: { Running: true }, ExecIDs: [] }),
      stop: async () => {
        stopped++;
      },
      remove: async (o: unknown) => {
        removed++;
        options = o;
      },
    }),
  };
  const f = fixture();
  try {
    const config = new RuntimeConfig(join(f.dir, "runtime.json")).value;
    assert.equal(await backend.prepare(f.id, config, true), false);
    assert.equal(removed, 0);
    missing = true;
    await assert.rejects(backend.prepare(f.id, config, false), /Image missing/);
    assert.equal(stopped, 0);
    missing = false;
    assert.equal(await backend.prepare(f.id, config, false), true);
    assert.equal(stopped, 1);
    assert.equal(removed, 1);
    assert.deepEqual(options, { v: false });
    assert.deepEqual(workerCommand, ["python3", "/opt/tessera/traffic/traffic-launch.py"]);
  } finally {
    f.close();
  }
});

test("ID allocation handles more than the engine argument limit", () => {
  const f = fixture();
  try {
    assert.equal(
      (f.store as any).next(
        Array.from({ length: 130000 }, (_, i) => ({ id: `f${i + 1}` })),
        "f",
      ),
      "f130001",
    );
  } finally {
    f.close();
  }
});

test("one project's failed container preparation does not starve healthy projects", async (t) => {
  const f = fixture(),
    claims: string[] = [];
  t.mock.method(console, "error", () => {});
  const dispatcher = new Dispatcher(
    {
      request: async (path: string) => {
        if (path === "/projects")
          return [
            { id: "broken", status: "active" },
            { id: "healthy", status: "active" },
          ];
        claims.push(path);
        return null;
      },
    } as any,
    {
      prepare: async (id) => {
        if (id === "broken") throw new Error("container removal conflict");
        return true;
      },
      run: async () => {},
    },
  );
  try {
    const config = new RuntimeConfig(join(f.dir, "runtime.json")).value;
    config.model.id = "fixture";
    config.model.base_url = "http://fixture.test/v1";
    config.max_project_workers = 1;
    await dispatcher.tick(config);
    assert.deepEqual(claims, ["/projects/healthy/jobs/claim"]);
  } finally {
    await dispatcher.stop();
    f.close();
  }
});

test("manual completion ends Execute and successful Review ends its exact active Run", () => {
  for (const complete of [true, false]) {
    const f = fixture();
    try {
      const planner = f.store.claim(f.id, "planner", 0)!,
        snapshot = f.store.get(f.id);
      commitPlan(
        f.store,
        f.id,
        decideSchema.parse({
          worker: planner.worker,
          revision: snapshot.revision,
          observation_revision: snapshot.observation_revision,
          planning_revision: snapshot.planning_revision,
          steps: [{ from: ["origin"], description: "Inspect" }],
        }),
      );
      const executor = f.store.claim(f.id, "executor", 0)!;
      if (complete) {
        f.store.externalAction(f.id, executor);
        const closing = f.store.manualComplete(f.id, ["origin"], "Inspect", "human");
        assert.notEqual(closing.id, executor.step_id, "archival completion must not repurpose a live task");
        assert.equal(closing.worker, null);
        f.store.release(f.id, executor);
        assert.equal(f.store.runs(f.id).find((r) => r.id === executor.run_id)!.status, "needs_attention");
      } else {
        const e = proof(f.store, f.id);
        const finding = f.store.submitStepFinding(
          f.id,
          executor.step_id!,
          executor.worker,
          findingSchema.parse({
            ...reportFields,
            title: "Claim",
            description: "Verified",
            evidence_ids: [e.id],
            cvss: withImpactEvidence(cvss.high, [e.id]),
          }),
        );
        f.store.manualConclude(f.id, executor.step_id!, executor.worker, "Done");
        const reviewer = f.store.claim(f.id, "reviewer", deferDecideMs)!;
        assert.equal(reviewer.kind, "review");
        recordReview(f.store, f.id, finding.id, "confirmed", "human", "Original evidence checked", "vulnerability");
        f.store.release(f.id, reviewer);
        assert.equal(f.store.runs(f.id).find((r) => r.id === reviewer.run_id)!.status, "succeeded");
      }
      assert.ok(f.store.runs(f.id).every((r) => r.status !== "running"));
    } finally {
      f.close();
    }
  }
});
