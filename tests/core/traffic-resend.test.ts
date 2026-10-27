import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema } from "../../packages/protocol/src/traffic.js";

test("resending a captured HTTP flow sends the real request without archiving the response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-resend-")),
    store = new Store(join(dir, "graph.db"));
  let received: { method?: string; url?: string; header?: string; body?: string } = {};
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        url: request.url,
        header: request.headers["x-test"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(201, { "content-type": "application/json", "x-reply": "yes" });
      response.end('{"ok":true}');
    });
  });
  try {
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as AddressInfo).port;
    const id = store.create(
      createProjectSchema.parse({ title: "Resend fixture", origin: "http://127.0.0.1:" + port, goal: "Assess" }),
    ).project.id;
    const body = '{"hello":"world"}';
    store.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "source-flow",
        created_at: new Date().toISOString(),
        method: "POST",
        url: "http://127.0.0.1:" + port + "/echo?x=1",
        host: "127.0.0.1",
        protocol: "HTTP/1.1",
        status: 200,
        duration_ms: 4,
        run_id: "run-1",
        step_id: "s001",
        request: {
          head:
            "POST /echo?x=1 HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nContent-Type: application/json\r\nX-Test: yes",
          body_base64: Buffer.from(body).toString("base64"),
          size: Buffer.byteLength(body),
        },
      }),
    ]);

    const resent = await store.resendTraffic(id, "source-flow");
    assert.equal(resent.method, "POST");
    assert.equal(resent.status, 201);
    assert.deepEqual(received, { method: "POST", url: "/echo?x=1", header: "yes", body });
    assert.match(resent.request_head, /^POST \/echo\?x=1 HTTP\/1\.1/);
    assert.match(resent.response_head || "", /^HTTP\/1\.1 201/);
    assert.equal(Buffer.from(resent.body_base64, "base64").toString("utf8"), '{"ok":true}');
    const rows = store.traffic.list(id, 0, 10);
    assert.deepEqual(
      rows.map((record) => record.id),
      ["source-flow"],
      "a resend is transient and never adds a traffic record",
    );
  } finally {
    await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
