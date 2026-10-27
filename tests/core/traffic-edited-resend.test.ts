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

test("editing the raw request changes method, path, headers and body without archiving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-edit-")),
    store = new Store(join(dir, "graph.db"));
  let received: {
    method?: string;
    url?: string;
    host?: string;
    header?: string;
    length?: string;
    connection?: string;
    body?: string;
  } = {};
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        url: request.url,
        host: request.headers.host,
        header: request.headers["x-edited"] as string | undefined,
        length: request.headers["content-length"],
        connection: request.headers.connection,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(202, { "content-type": "text/plain" });
      response.end("edited-accepted");
    });
  });
  try {
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as AddressInfo).port;
    const id = store.create(
      createProjectSchema.parse({ title: "Edit fixture", origin: "http://127.0.0.1:" + port, goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [
      trafficRecordSchema.parse({
        id: "source-flow",
        created_at: new Date().toISOString(),
        method: "POST",
        url: "http://127.0.0.1:" + port + "/original",
        host: "127.0.0.1",
        protocol: "HTTP/1.1",
        status: 200,
        duration_ms: 4,
        request: {
          head: "POST /original HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nContent-Type: text/plain",
          body_base64: Buffer.from("before").toString("base64"),
          size: 6,
        },
      }),
    ]);

    const raw = [
      "PATCH /edited?x=2 HTTP/1.1",
      "Host: virtual.test",
      "Content-Type: text/plain",
      "Content-Length: 999",
      "Connection: keep-alive",
      "X-Edited: yes",
      "",
      "after",
    ].join("\n");
    const resent = await store.resendTraffic(id, "source-flow", raw);
    assert.equal(resent.method, "PATCH");
    assert.equal(resent.url, "http://127.0.0.1:" + port + "/edited?x=2");
    assert.match(resent.request_head, /^PATCH \/edited\?x=2 HTTP\/1\.1/);
    assert.match(resent.request_head, /Content-Length: 5/);
    assert.doesNotMatch(resent.request_head, /Content-Length: 999/);
    assert.equal(resent.status, 202);
    assert.equal(Buffer.from(resent.body_base64, "base64").toString("utf8"), "edited-accepted");
    assert.deepEqual(received, {
      method: "PATCH",
      url: "/edited?x=2",
      host: "virtual.test",
      header: "yes",
      length: "5",
      connection: "close",
      body: "after",
    });
    assert.deepEqual(
      store.traffic.list(id, 0, 10).map((record) => record.id),
      ["source-flow"],
      "an edited resend is transient and never adds a traffic record",
    );

    await assert.rejects(
      () => store.resendTraffic(id, "source-flow", "GET http://elsewhere.test/ HTTP/1.1\n\n"),
      /只能修改请求路径/,
    );
    await assert.rejects(() => store.resendTraffic(id, "source-flow", "not a request"), /请求行格式无效/);
  } finally {
    await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
