import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { DockerBackend } from "../../apps/dispatcher/src/docker.js";
import type { DispatchConfig, Job } from "../../packages/protocol/src/index.js";

const job = { project_id: "fixture", kind: "decide", worker: "worker", graph_id: "main" } as Job;
const config = { volume_prefix: "fixture", worker_image: "fixture" } as DispatchConfig;

test("Docker execution survives silence, remains cancellable, and bounds control requests", async t => {
  let holdControl = false, cancel = false, killed = false;
  let started: () => void = () => {};
  const server = createServer(async (req, res) => {
    req.resume();
    const path = req.url!;
    res.setHeader("Content-Type", "application/json");
    if (path.endsWith("/start")) {
      res.setHeader("Content-Type", "application/vnd.docker.raw-stream");
      res.flushHeaders();
      started();
      if (path.includes("/kill/")) { killed = true; res.end(); return; }
      if (cancel) return;
      await delay(450);
      res.end();
    } else if (path.includes("/containers/") && path.endsWith("/json")) {
      res.end(JSON.stringify({ Id: "container", Image: "image", State: { Running: true } }));
    } else if (path.includes("/images/")) {
      if (holdControl) await delay(450);
      res.end(JSON.stringify({ Id: "image" }));
    } else if (path.endsWith("/exec")) {
      let body = "";
      // Requests may already be flowing, but the handler runs before their data events.
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { res.end(JSON.stringify({ Id: body.includes('"kill"') ? "kill" : "execution" })); });
    } else if (path.includes("/exec/") && path.endsWith("/json")) {
      res.end(JSON.stringify({ ExitCode: 0, Pid: 123 }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await t.test("silent execution exceeds the control timeout and succeeds", async () => {
    await backend.run(job, config, new AbortController().signal);
  });
  await t.test("manual cancellation still stops the attached execution", async () => {
    cancel = true;
    const controller = new AbortController();
    const ready = new Promise<void>(resolve => { started = resolve; });
    const running = backend.run(job, config, controller.signal);
    const rejected = assert.rejects(running, /Job cancelled/);
    await ready;
    controller.abort();
    await rejected;
    for (let i = 0; i < 50 && !killed; i++) await delay(10);
    assert.equal(killed, true);
  });
  await t.test("unresponsive control API still times out", async () => {
    holdControl = true;
    await assert.rejects(backend.prepare("fixture", config, false));
  });
});
