import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { DockerBackend } from "../../apps/dispatcher/src/docker.js";
import type { DispatchConfig, Job } from "../../packages/protocol/src/index.js";

const job = { project_id: "conflict", kind: "decide", worker: "worker", graph_id: "main" } as Job;
const config = { volume_prefix: "fixture", worker_image: "fixture" } as DispatchConfig;

function respond(res: ServerResponse, status: number, body: unknown = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

test("a restored container that is briefly invisible is reused after a 409 instead of failing the job", async t => {
  let refused = 2, created = 0, starts = 0;
  const server = createServer((req, res) => {
    req.resume();
    const url = req.url!;
    if (url.startsWith("/containers/create")) {
      created++;
      return respond(res, 409, { message: "Conflict. The container name is already in use" });
    }
    if (url.startsWith("/containers/") && url.endsWith("/json")) {
      if (refused-- > 0) return respond(res, 404, {});
      return respond(res, 200, { Id: "container", Image: "image", State: { Running: false } });
    }
    if (url.startsWith("/containers/") && url.endsWith("/start")) { starts++; return respond(res, 200); }
    if (url.startsWith("/containers/") && url.endsWith("/exec")) return respond(res, 200, { Id: "execution" });
    if (url.startsWith("/exec/") && url.endsWith("/start")) {
      res.setHeader("Content-Type", "application/vnd.docker.raw-stream");
      return res.end();
    }
    if (url.startsWith("/exec/") && url.endsWith("/json")) return respond(res, 200, { ExitCode: 0, Pid: 1 });
    if (url.startsWith("/volumes/create")) return respond(res, 201, { Name: "fixture-workspace-conflict" });
    if (url.startsWith("/images/")) return respond(res, 200, { Id: "image" });
    return respond(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await backend.run(job, config, new AbortController().signal);
  assert.equal(created, 1, "create is attempted once before the conflict is resolved by reuse");
  assert.equal(starts, 1, "the restored container is started for the run");
});

test("a worker container left on a recreated network is removed and rebuilt instead of failing the job", async t => {
  let starts = 0, removed = 0, created = 0;
  const server = createServer((req, res) => {
    req.resume();
    const url = req.url!;
    if (url.startsWith("/containers/create")) { created++; return respond(res, 201, { Id: "rebuilt" }); }
    if (url.startsWith("/containers/") && url.endsWith("/json"))
      return respond(res, 200, { Id: "container", Image: "image", State: { Running: false } });
    if (url.startsWith("/containers/") && url.endsWith("/start")) {
      starts++;
      if (starts === 1)
        return respond(res, 404, {
          message: "failed to set up container networking: network 745d4e8b4c332250e6cc0864924b21496a8563824a5d39ad73ba537884f67bec not found",
        });
      return respond(res, 200);
    }
    if (req.method === "DELETE" && url.startsWith("/containers/")) { removed++; return respond(res, 204); }
    if (url.startsWith("/containers/") && url.endsWith("/exec")) return respond(res, 200, { Id: "execution" });
    if (url.startsWith("/exec/") && url.endsWith("/start")) {
      res.setHeader("Content-Type", "application/vnd.docker.raw-stream");
      return res.end();
    }
    if (url.startsWith("/exec/") && url.endsWith("/json")) return respond(res, 200, { ExitCode: 0, Pid: 1 });
    if (url.startsWith("/volumes/create")) return respond(res, 201, { Name: "fixture-workspace-conflict" });
    if (url.startsWith("/images/")) return respond(res, 200, { Id: "image" });
    return respond(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await backend.run(job, config, new AbortController().signal);
  assert.equal(removed, 1, "the container bound to the deleted network is removed");
  assert.equal(created, 1, "the worker is recreated on the current network");
  assert.equal(starts, 2, "the recreated container is started for the run");
});

test("a worker failing to start for another reason is reported instead of rebuilt", async t => {
  let created = 0;
  const server = createServer((req, res) => {
    req.resume();
    const url = req.url!;
    if (url.startsWith("/containers/create")) { created++; return respond(res, 201, { Id: "rebuilt" }); }
    if (url.startsWith("/containers/") && url.endsWith("/json"))
      return respond(res, 200, { Id: "container", Image: "image", State: { Running: false } });
    if (url.startsWith("/containers/") && url.endsWith("/start"))
      return respond(res, 500, { message: "OCI runtime create failed: no such file or directory" });
    if (url.startsWith("/images/")) return respond(res, 200, { Id: "image" });
    return respond(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await assert.rejects(backend.run(job, config, new AbortController().signal), (error: any) => error.statusCode === 500);
  assert.equal(created, 0, "unrelated start failures never delete the existing container");
});

test("a container whose workspace volume disappeared is rebuilt instead of failing every run", async t => {
  let starts = 0, removed = 0, created = 0, volumes = 0;
  const volume = `${config.volume_prefix}-workspace-${job.project_id}`;
  const server = createServer((req, res) => {
    req.resume();
    const url = req.url!;
    if (url.startsWith("/containers/create")) { created++; return respond(res, 201, { Id: "rebuilt" }); }
    if (url.startsWith("/containers/") && url.endsWith("/json"))
      return respond(res, 200, { Id: "container", Image: "image", State: { Running: false },
        Mounts: [{ Type: "volume", Name: volume, Destination: "/workspace" }] });
    if (url.startsWith("/containers/") && url.endsWith("/start")) { starts++; return respond(res, 200); }
    if (req.method === "DELETE" && url.startsWith("/containers/")) { removed++; return respond(res, 204); }
    if (url.startsWith("/volumes/create")) { volumes++; return respond(res, 201, { Name: volume }); }
    if (url === `/volumes/${volume}`) return respond(res, 404, { message: "no such volume" });
    if (url.startsWith("/containers/") && url.endsWith("/exec")) return respond(res, 200, { Id: "execution" });
    if (url.startsWith("/exec/") && url.endsWith("/start")) {
      res.setHeader("Content-Type", "application/vnd.docker.raw-stream");
      return res.end();
    }
    if (url.startsWith("/exec/") && url.endsWith("/json")) return respond(res, 200, { ExitCode: 0, Pid: 1 });
    if (url.startsWith("/images/")) return respond(res, 200, { Id: "image" });
    return respond(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await backend.run(job, config, new AbortController().signal);
  assert.equal(removed, 1, "the container with the missing volume is removed");
  assert.equal(volumes, 1, "the missing volume is recreated");
  assert.equal(created, 1, "the worker container is recreated");
  assert.equal(starts, 1);
});

test("a temporarily missing worker image is not mistaken for a missing container", async t => {
  let created = 0;
  const server = createServer((req, res) => {
    req.resume();
    const url = req.url!;
    if (url.startsWith("/containers/create")) { created++; return respond(res, 409, {}); }
    if (url.startsWith("/containers/") && url.endsWith("/json"))
      return respond(res, 200, { Id: "container", Image: "image", State: { Running: true } });
    if (url.startsWith("/images/")) return respond(res, 404, {});
    return respond(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const backend = new DockerBackend({ host: "127.0.0.1", port: address.port, protocol: "http", timeout: 150 });

  await assert.rejects(backend.run(job, config, new AbortController().signal), (error: any) => error.statusCode === 404);
  assert.equal(created, 0, "no container is created when only the image lookup fails");
});
