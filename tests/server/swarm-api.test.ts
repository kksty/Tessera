import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";

test("swarm worker routes: facts, messages, inbox, consensus and turn release are wired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-swarm-api-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Swarm API", origin: "https://example.test", goal: "Assess", mode: "swarm" }),
  ).project.id;
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const worker = { "x-tessera-worker-token": testWorkerToken };
  try {
    const view = await app.inject({ method: "GET", url: `/api/projects/${id}/swarm`, headers: worker });
    assert.equal(view.statusCode, 200, view.body);
    assert.equal(view.json().mode, "swarm");
    assert.equal(view.json().peers.length, 1);

    const job = store.claim(id, "w1", 0)!;
    assert.equal(job.kind, "peer");
    const base = `/api/projects/${id}/fgs/peers/p001`;

    const fact = await app.inject({
      method: "POST",
      url: `${base}/facts`,
      headers: worker,
      payload: {
        submission_id: randomUUID(),
        run_id: job.run_id,
        worker: "w1",
        description: "首页返回 200",
        conclusion: "首页可访问",
        objects: ["https://example.test/"],
        evidence_ids: [],
      },
    });
    assert.equal(fact.statusCode, 200, fact.body);
    assert.equal(store.get(id).facts.filter((f) => f.id !== "origin").length, 1);

    const message = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      headers: worker,
      payload: { submission_id: randomUUID(), run_id: job.run_id, worker: "w1", kind: "share", body: "进度" },
    });
    assert.equal(message.statusCode, 200, message.body);

    const inbox = await app.inject({ method: "GET", url: `${base}/inbox`, headers: worker });
    assert.equal(inbox.statusCode, 200, inbox.body);

    const traffic = await app.inject({ method: "GET", url: `${base}/traffic`, headers: worker });
    assert.equal(traffic.statusCode, 200, traffic.body);
    assert.ok(Array.isArray(traffic.json()));

    const propose = await app.inject({
      method: "POST",
      url: `${base}/completion/propose`,
      headers: worker,
      payload: {
        submission_id: randomUUID(),
        run_id: job.run_id,
        worker: "w1",
        reason: "enough",
        coverage: [{ surface: "https://example.test/", status: "na" }],
      },
    });
    assert.equal(propose.statusCode, 200, propose.body);
    const roundId = propose.json().id;

    const respond = await app.inject({
      method: "POST",
      url: `${base}/completion/respond`,
      headers: worker,
      payload: { submission_id: randomUUID(), run_id: job.run_id, worker: "w1", round_id: roundId, opinion: "agree" },
    });
    assert.equal(respond.statusCode, 200, respond.body);

    const turnEnd = await app.inject({
      method: "POST",
      url: `${base}/turn-end`,
      headers: worker,
      payload: { submission_id: randomUUID(), run_id: job.run_id, worker: "w1", wake: "waiting", summary: "done" },
    });
    assert.equal(turnEnd.statusCode, 200, turnEnd.body);

    const release = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/jobs/release`,
      headers: worker,
      payload: { job },
    });
    assert.equal(release.statusCode, 200, release.body);
    assert.equal(store.get(id).project.status, "completed");
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator can retry a stuck peer over the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-swarm-retry-"));
  const store = new Store(join(dir, "graph.db"));
  const id = store.create(
    createProjectSchema.parse({ title: "Swarm Retry", origin: "https://example.test", goal: "Assess", mode: "swarm" }),
  ).project.id;
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "no-web"));
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    for (let i = 0; i < 3; i++) {
      const job = store.claim(id, `w${i}`, 0)!;
      assert.equal(job.peer_id, "p001");
      store.release(id, job, "boom");
    }
    assert.equal(store.swarm.state(id, "p001").wake, "stuck");
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/fgs/peers/p001/retry`,
      payload: { confirmed: true },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), { ok: true, peer_id: "p001" });
    assert.equal(store.swarm.state(id, "p001").wake, "ready");
    assert.equal(store.get(id).project.job_failures?.["peer:p001"], 0);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
