import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema } from "../../packages/protocol/src/traffic.js";

test("finding traffic API returns linked flows and the worker Step query returns capture rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-api-")),
    store = new Store(join(dir, "graph.db")),
    app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Traffic API", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    const record = trafficRecordSchema.parse({
      id: "flow-api",
      created_at: new Date().toISOString(),
      method: "POST",
      url: "https://api.example.test/users/7",
      host: "api.example.test",
      status: 201,
      duration_ms: 8,
      run_id: "run-1",
      step_id: "s001",
      request: { head: "POST /users/7 HTTP/1.1\r\nHost: api.example.test", size: 0 },
      response: { head: "HTTP/1.1 201 Created\r\nContent-Type: application/json", size: 2, body_base64: "e30=" },
    });
    store.traffic.ingest(id, [record]);
    store.mutate(id, "seed-step", false, (graph) => {
      graph.steps.push({
        id: "s001",
        from: [],
        to: null,
        description: "Test the profile endpoint",
        priority: 1,
        discarded: false,
        creator: "test",
        worker: null,
        last_heartbeat_at: null,
        created_at: new Date().toISOString(),
        concluded_at: null,
        fact_ids: [],
        summary: "",
        graph_id: "main",
        attempts: 0,
        run_id: "run-1",
      });
    });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "Profile write",
        description: "The endpoint accepted a cross-user write.",
        traffic_ids: ["flow-api"],
      }),
    );

    const linked = await app.inject(`/api/projects/${id}/findings/${finding.id}/traffic`);
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(linked.json().source, "linked");
    assert.deepEqual(
      linked.json().records.map((item: any) => item.id),
      ["flow-api"],
    );

    const stepTraffic = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/fgs/steps/s001/traffic`,
      headers: { "x-tessera-worker-token": testWorkerToken },
    });
    assert.equal(stepTraffic.statusCode, 200, stepTraffic.body);
    assert.deepEqual(
      stepTraffic.json().map((item: any) => item.id),
      ["flow-api"],
    );

    const missing = await app.inject(`/api/projects/${id}/findings/v999/traffic`);
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("operator confirmation pins a captured flow that the executor did not cite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-confirm-api-")),
    store = new Store(join(dir, "graph.db")),
    app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Confirm API", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "flow-proof",
        created_at: new Date().toISOString(),
        method: "GET",
        url: "https://api.example.test/users/7",
        host: "api.example.test",
        status: 200,
        duration_ms: 4,
        request: { head: "GET /users/7 HTTP/1.1\r\nHost: api.example.test", size: 0 },
        response: { head: "HTTP/1.1 200 OK\r\nContent-Type: application/json", size: 2, body_base64: "e30=" },
      }),
    ]);
    const finding = store.submitFinding(
      id,
      findingSchema.parse({ title: "Uncited claim", description: "No flow was cited." }),
    );

    const confirmed = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}/findings/${finding.id}/traffic`,
      payload: { traffic_ids: ["flow-proof"] },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().source, "linked");
    assert.deepEqual(
      confirmed.json().records.map((item: any) => item.id),
      ["flow-proof"],
    );

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}/findings/${finding.id}/traffic`,
      payload: { traffic_ids: [] },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.notEqual(cleared.json().source, "linked");

    const unknown = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}/findings/${finding.id}/traffic`,
      payload: { traffic_ids: ["missing"] },
    });
    assert.equal(unknown.statusCode, 422, unknown.body);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("operator resend API sends a real request without adding a traffic record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-resend-api-")),
    store = new Store(join(dir, "graph.db")),
    app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  let received = { method: "", body: "" };
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = { method: request.method || "", body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(202, { "content-type": "text/plain" });
      response.end("accepted");
    });
  });
  try {
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as AddressInfo).port;
    const id = store.create(
      createProjectSchema.parse({ title: "Resend API", origin: "http://127.0.0.1:" + port, goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "flow-source",
        created_at: new Date().toISOString(),
        method: "PUT",
        url: "http://127.0.0.1:" + port + "/write",
        host: "127.0.0.1",
        status: 200,
        duration_ms: 2,
        request: {
          head: "PUT /write HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nContent-Type: text/plain",
          body_base64: Buffer.from("payload").toString("base64"),
          size: 7,
        },
      }),
    ]);

    const result = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/traffic/flow-source/resend`,
    });
    assert.equal(result.statusCode, 200, result.body);
    const body = result.json();
    assert.equal(body.status, 202);
    assert.equal(Buffer.from(body.body_base64, "base64").toString("utf8"), "accepted");
    assert.deepEqual(received, { method: "PUT", body: "payload" });
    assert.deepEqual(
      store.traffic.list(id, 0, 10).map((record) => record.id),
      ["flow-source"],
      "the resend result is transient and not archived",
    );
    assert.equal(store.get(id).revision, 1, "traffic replay does not bump the graph revision");
  } finally {
    await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator resend API accepts an edited raw request without archiving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-edit-api-")),
    store = new Store(join(dir, "graph.db")),
    app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  let received = { method: "", url: "", body: "" };
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method || "",
        url: request.url || "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(203, { "content-type": "text/plain" });
      response.end("edited");
    });
  });
  try {
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as AddressInfo).port;
    const id = store.create(
      createProjectSchema.parse({ title: "Edit API", origin: "http://127.0.0.1:" + port, goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "flow-edit",
        created_at: new Date().toISOString(),
        method: "POST",
        url: "http://127.0.0.1:" + port + "/original",
        host: "127.0.0.1",
        status: 200,
        duration_ms: 1,
        request: { head: "POST /original HTTP/1.1\r\nHost: 127.0.0.1:" + port, size: 0 },
      }),
    ]);

    const result = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/traffic/flow-edit/resend`,
      payload: { request: "DELETE /edited HTTP/1.1\nHost: 127.0.0.1:" + port + "\n\n" },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().method, "DELETE");
    assert.equal(result.json().status, 203);
    assert.deepEqual(received, { method: "DELETE", url: "/edited", body: "" });
    assert.deepEqual(
      store.traffic.list(id, 0, 10).map((record) => record.id),
      ["flow-edit"],
    );

    const invalid = await app.inject({
      method: "POST",
      url: `/api/projects/${id}/traffic/flow-edit/resend`,
      payload: { request: "GET http://other.test/ HTTP/1.1\n\n" },
    });
    assert.equal(invalid.statusCode, 422);
    assert.match(invalid.json().detail, /只能修改请求路径/);
  } finally {
    await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
