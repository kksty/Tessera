import { setTimeout as sleep } from "node:timers/promises";
import { ApiClient } from "../../../packages/runner/src/client.js";
import type { DispatchConfig } from "../../../packages/protocol/src/index.js";
import { DockerBackend } from "./docker.js";
import { Dispatcher } from "./loop.js";
import Fastify from "fastify";
import { DockerWorkspace } from "./workspace.js";
import { z } from "zod";
import { internalToken, validInternalToken } from "../../../packages/protocol/src/internal-auth.js";
import { readWorkspaceSecret, workspaceSignature } from "../../../packages/protocol/src/workspace-auth.js";
import { timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { deleteProjectResources } from "./project-resources.js";
import Docker from "dockerode";
import type { Graph } from "../../../packages/protocol/src/index.js";
const workerToken = internalToken();
process.env.TESSERA_WORKER_TOKEN = workerToken;
const client = new ApiClient(process.env.TESSERA_SERVER || "http://tessera-server:8000", workerToken);
const backend = new DockerBackend(),
  dispatcher = new Dispatcher(client, backend);
// A restarted dispatcher has no in-memory knowledge of earlier execs. Terminate
// them so an expired lease cannot be re-claimed while the old process still runs.
await backend
  .recover()
  .catch((error) => console.error("Exec recovery:", error instanceof Error ? error.message : error));
const files = new DockerWorkspace((id) => backend.isDeleting(id)),
  workspaceApi = Fastify();
const workspaceKey = readWorkspaceSecret(dirname(process.env.TESSERA_TOKEN_FILE || ".tessera/internal-token"));
// The worker token alone is not project authorization: it lives in every
// container. The server adds an HMAC over the project id with a key that only
// the server and dispatcher share.
const workspaceAllowed = (req: { headers: Record<string, unknown> }, projectId: string) => {
  const supplied = String(req.headers["x-tessera-workspace-signature"] || "");
  const expected = workspaceSignature(workspaceKey, projectId);
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};
const cleanupDocker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock", timeout: 30000 });
const deleting = new Map<string, Promise<unknown>>();
workspaceApi.setErrorHandler((error, _req, reply) =>
  reply
    .code(error instanceof z.ZodError ? 422 : (error as any).statusCode || 500)
    .send({ detail: error instanceof Error ? error.message : "Workspace request failed" }),
);
// The dispatcher listens on 8001, but the image-level healthcheck probes the
// server's 8000, so `docker ps` reported the dispatcher unhealthy forever.
// Expose a tiny unauthenticated liveness route and point Compose at it.
workspaceApi.get("/health", async () => ({ ok: true }));
workspaceApi.post<{ Params: { id: string } }>("/workspace/:id", async (req, reply) => {
  if (!validInternalToken(workerToken, req.headers["x-tessera-worker-token"]))
    return reply.code(403).send({ detail: "Worker token required" });
  if (!workspaceAllowed(req, req.params.id))
    return reply.code(403).send({ detail: "Workspace access is not authorized for this project" });
  const request = z
    .object({
      operation: z.enum(["list", "read", "delete"]),
      path: z.string().min(1).max(4096),
      limit: z.number().int().positive().max(33554432).optional(),
    })
    .parse(req.body);
  const graph = await client.request<Graph>(`/projects/${encodeURIComponent(req.params.id)}`);
  if (graph.project.deletion) return reply.code(409).send({ detail: "项目正在删除，工作区已锁定" });
  try {
    return await files.run(req.params.id, await client.request<DispatchConfig>("/runtime/config"), request);
  } catch (error: any) {
    return reply.code(error.statusCode || 502).send({ detail: error.message });
  }
});
workspaceApi.post<{ Params: { id: string } }>("/projects/:id/resources/delete", async (req, reply) => {
  if (!validInternalToken(workerToken, req.headers["x-tessera-worker-token"]))
    return reply.code(403).send({ detail: "Worker token required" });
  if (!workspaceAllowed(req, req.params.id))
    return reply.code(403).send({ detail: "Deletion is not authorized for this project" });
  const { deletion_id } = z.object({ deletion_id: z.string().uuid() }).strict().parse(req.body);
  const graph = await client.request<Graph>(`/projects/${encodeURIComponent(req.params.id)}`);
  if (!graph.project.deletion || graph.project.deletion.id !== deletion_id || graph.project.status !== "stopped")
    return reply.code(409).send({ detail: "项目尚未进入已确认的删除状态" });
  const existing = deleting.get(req.params.id);
  if (existing) return existing;
  backend.blockProject(req.params.id);
  const marker = graph.project.deletion;
  const task = (async () => {
    await dispatcher.cancelProject(req.params.id);
    await backend.drainCreation(req.params.id);
    await files.drainProject(req.params.id);
    const result = await deleteProjectResources(cleanupDocker, req.params.id, marker.volume_prefix);
    return { ...result, project_id: req.params.id, deletion_id };
  })();
  deleting.set(req.params.id, task);
  try {
    return await task;
  } finally {
    deleting.delete(req.params.id);
  }
});
await workspaceApi.listen({ host: "0.0.0.0", port: Number(process.env.TESSERA_WORKSPACE_PORT || 8001) });
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopped = true;
    void dispatcher.stop();
  });
while (!stopped) {
  let interval = 1000;
  try {
    const config = await client.request<DispatchConfig>("/runtime/config");
    interval = config.interval_ms;
    const projects = await dispatcher.tick(config);
    await backend.reconcile(
      projects.filter((p) => p.status === "active").map((p) => p.id),
      config,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dispatcher unavailable");
  }
  await sleep(interval);
}
await dispatcher.stop();
await workspaceApi.close();
