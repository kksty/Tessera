import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { buildApp as authenticatedApp } from "../../apps/server/src/app.js";
import { OperatorAuth, sessionCookie } from "../../apps/server/src/operator-auth.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { deleteProjectResources } from "../../apps/dispatcher/src/project-resources.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-delete-")), store = new Store(join(dir, "graph.db"));
  const id = store.create(createProjectSchema.parse({ title: "Delete fixture", origin: "https://example.test", goal: "Assess" })).project.id;
  const runtime = new RuntimeConfig(join(dir, "runtime.json"));
  return { dir, store, id, runtime, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function fakeDocker() {
  const id = "proj_fixture", name = `tessera-worker-${id}`, volume = `tessera-workspace-${id}`;
  const worker = { Id: "worker-id", Name: `/${name}`, Config: { Labels: { "tessera.project": id, "tessera.managed": "true" } },
    State: { Running: true }, Mounts: [{ Type: "volume", Name: volume, Destination: "/workspace" }] };
  const helper = { Id: "helper-id", Name: "/helper", Config: { Labels: { "tessera.project": id, "tessera.workspace-helper": "true" } },
    State: { Running: false }, Mounts: worker.Mounts };
  const containers = new Map<string, { Id: string; Name: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; Mounts: { Type: string; Name: string; Destination: string }[] }>([[worker.Id, worker], [helper.Id, helper]]);
  const volumes = new Map([[volume, { Name: volume, Labels: { "tessera.project": id } }]]);
  const actions: string[] = [];
  const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
  const docker = {
    getContainer(key: string) {
      const lookup = () => containers.get(key) ?? [...containers.values()].find(item => item.Name === `/${key}`);
      return { inspect: async () => { const item = lookup(); if (!item) throw notFound(); return item; },
        stop: async () => { const item = lookup(); if (!item) throw notFound(); actions.push(`stop:${item.Id}`); item.State.Running = false; },
        remove: async (options: { v: boolean }) => { assert.equal(options.v, false); const item = lookup(); if (!item) throw notFound(); assert.equal(item.State.Running, false); actions.push(`remove:${item.Id}`); containers.delete(item.Id); } };
    },
    getVolume(key: string) { return { inspect: async () => { if (!volumes.has(key)) throw notFound(); return volumes.get(key); },
      remove: async () => { assert.ok(![...containers.values()].some(item => item.Mounts.some(m => m.Name === key))); actions.push(`volume:${key}`); volumes.delete(key); } }; },
    listContainers: async (options: { filters?: string }) => {
      const filtered = options.filters ? [...containers.values()].filter(item => item.Config.Labels["tessera.project"] === id) : [...containers.values()];
      return filtered.map(item => ({ ...item, Names: [item.Name], Labels: item.Config.Labels }));
    },
    listVolumes: async () => ({ Volumes: [...volumes.values()] }),
  };
  return { id, name, volume, worker, helper, containers, volumes, actions, docker: docker as any };
}

test("Docker cleanup removes project worker/helpers and then the workspace, with repeat-safe missing resources", async () => {
  const f = fakeDocker();
  const result = await deleteProjectResources(f.docker, f.id, "tessera");
  assert.equal(result.resources_deleted, true);
  assert.deepEqual(f.actions, ["remove:helper-id", "stop:worker-id", "remove:worker-id", `volume:${f.volume}`]);
  assert.equal(f.containers.size, 0); assert.equal(f.volumes.size, 0);
  await deleteProjectResources(f.docker, f.id, "tessera");
  assert.equal(f.actions.length, 4);
});

test("deletion recovers resources created under an earlier volume prefix", async () => {
  const f = fakeDocker();
  const result = await deleteProjectResources(f.docker, f.id, "new-prefix");
  assert.equal(result.container, f.name);
  assert.equal(result.workspace_volume, f.volume);
  assert.equal(f.containers.size, 0); assert.equal(f.volumes.size, 0);
});

test("the deletion marker uses the project's creation-time prefix", () => {
  const f = fixture();
  try {
    const project = f.store.create(createProjectSchema.parse({ title: "Prefix", origin: "https://example.test", goal: "Assess" }), "old-prefix");
    const marker = f.store.beginDeletion(project.project.id, "new-prefix");
    assert.equal(marker.volume_prefix, "old-prefix");
  } finally { f.close(); }
});

test("Docker ownership mismatches and foreign references stop deletion before any destructive action", async () => {
  for (const mode of ["container-owner", "volume-owner", "foreign-container", "other-prefix"]) {
    const f = fakeDocker();
    if (mode === "container-owner") f.worker.Config.Labels["tessera.project"] = "another";
    if (mode === "volume-owner") f.volumes.get(f.volume)!.Labels["tessera.project"] = "another";
    if (mode === "foreign-container") f.containers.set("other", { ...f.worker, Id: "other", Name: "/unrelated",
      Config: { Labels: { "tessera.project": "another", "tessera.managed": "true" } } });
    if (mode === "other-prefix") f.volumes.set("other-workspace", { Name: "other-workspace", Labels: { "tessera.project": f.id } });
    await assert.rejects(deleteProjectResources(f.docker, f.id, "tessera"));
    assert.deepEqual(f.actions, [], mode);
  }
});

test("a volume failure after container removal can be retried without forcing or recreating resources", async () => {
  const f = fakeDocker(), original = f.docker.getVolume.bind(f.docker);
  let busy = true;
  f.docker.getVolume = (name: string) => ({ ...original(name), remove: async () => {
    if (busy) throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
    return original(name).remove();
  } });
  await assert.rejects(deleteProjectResources(f.docker, f.id, "tessera"), /volume is in use/);
  assert.equal(f.containers.size, 0); assert.equal(f.volumes.size, 1);
  busy = false;
  await deleteProjectResources(f.docker, f.id, "tessera");
  assert.equal(f.volumes.size, 0);
});

test("full deletion requires confirmation, pauses/locks project, cleans Docker before evidence/records, and is retry-safe", async () => {
  const f = fixture();
  f.store.addEvidence(f.id, { title: "Raw", content: "proof", encoding: "utf8", mime_type: "text/plain" });
  const evidenceDirectory = join(f.store.evidenceRoot, f.id);
  let calls = 0;
  const app = buildApp(f.store, f.runtime, join(f.dir, "no-web"), undefined, { cleanupProject: async (id, deletionId) => {
    calls++;
    const graph = f.store.get(id);
    assert.equal(graph.project.status, "stopped");
    assert.equal(graph.project.deletion!.id, deletionId);
    assert.ok(existsSync(evidenceDirectory));
    assert.throws(() => f.store.claim(id, "late-worker", 0), /正在删除/);
    assert.throws(() => f.store.status(id, "active"), /正在删除/);
    return { project_id: id, deletion_id: deletionId, resources_deleted: true };
  } });
  try {
    const url = `/api/projects/${f.id}`;
    const plan = (await app.inject({ url: url + "/deletion-plan" })).json();
    assert.equal(plan.workspace_volume, `tessera-workspace-${f.id}`);
    assert.equal((await app.inject({ method: "DELETE", url })).statusCode, 422);
    assert.equal(calls, 0);
    assert.equal((await app.inject({ method: "DELETE", url, payload: { confirmed: true } })).statusCode, 204);
    assert.equal(calls, 1); assert.equal(existsSync(evidenceDirectory), false);
    assert.throws(() => f.store.get(f.id), /not found/i);
    assert.equal((await app.inject({ method: "DELETE", url, payload: { confirmed: true } })).statusCode, 204);
    assert.equal(calls, 1);
  } finally { await app.close(); f.close(); }
});

test("failed cleanup keeps evidence and durable deletion marker; retry uses the same operation", async () => {
  const f = fixture();
  f.store.addEvidence(f.id, { title: "Raw", content: "proof", encoding: "utf8", mime_type: "text/plain" });
  let failed = true;
  const ids: string[] = [];
  const app = buildApp(f.store, f.runtime, join(f.dir, "no-web"), undefined, { cleanupProject: async (id, deletionId) => {
    ids.push(deletionId);
    if (failed) throw new Error("卷仍被其他容器引用");
    return { project_id: id, deletion_id: deletionId, resources_deleted: true };
  } });
  try {
    const request = { method: "DELETE" as const, url: `/api/projects/${f.id}`, payload: { confirmed: true } };
    const response = await app.inject(request);
    assert.equal(response.statusCode, 409); assert.match(response.body, /其他容器引用/);
    assert.ok(existsSync(join(f.store.evidenceRoot, f.id)));
    const restarted = new Store(join(f.dir, "graph.db"));
    try { assert.equal(restarted.get(f.id).project.deletion!.id, ids[0]); } finally { restarted.close(); }
    failed = false;
    assert.equal((await app.inject(request)).statusCode, 204);
    assert.equal(ids[0], ids[1]);
  } finally { await app.close(); f.close(); }
});

test("global worker token alone cannot request full project deletion or view the deletion plan", async () => {
  const f = fixture(), auth = new OperatorAuth(join(f.dir, "operator.json"), { user: "owner", password: "test-password" });
  let calls = 0;
  const app = authenticatedApp(f.store, f.runtime, join(f.dir, "no-web"), testWorkerToken, { auth,
    cleanupProject: async () => { calls++; throw new Error("must not run"); } });
  try {
    const url = `/api/projects/${f.id}`, headers = { "x-tessera-worker-token": testWorkerToken };
    assert.equal((await app.inject({ method: "DELETE", url, headers, payload: { confirmed: true } })).statusCode, 403);
    assert.equal((await app.inject({ url: url + "/deletion-plan", headers })).statusCode, 403);
    assert.equal(calls, 0);
    assert.equal((await app.inject({ url: url + "/deletion-plan", headers: { cookie: sessionCookie(auth.issue()) } })).statusCode, 200);
  } finally { await app.close(); f.close(); }
});

test("concurrent delete requests share one cleanup operation", async () => {
  const f = fixture();
  let calls = 0, notify!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { notify = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const app = buildApp(f.store, f.runtime, join(f.dir, "no-web"), undefined, { cleanupProject: async (id, deletionId) => {
    calls++; notify(); await release;
    return { project_id: id, deletion_id: deletionId, resources_deleted: true };
  } });
  try {
    const request = { method: "DELETE" as const, url: `/api/projects/${f.id}`, payload: { confirmed: true } };
    const first = app.inject(request).then(response => response);
    await entered;
    const second = app.inject(request).then(response => response);
    await new Promise(resolve => setImmediate(resolve));
    finish();
    assert.deepEqual((await Promise.all([first, second])).map(response => response.statusCode), [204, 204]);
    assert.equal(calls, 1);
  } finally { finish(); await app.close(); f.close(); }
});
