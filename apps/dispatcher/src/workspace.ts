import Docker from "dockerode";
import { demuxDockerChunk } from "./docker.js";
import type { DispatchConfig } from "../../../packages/protocol/src/index.js";

export interface FileRequest { operation: "list" | "read" | "delete"; path: string; limit?: number }
// Self-contained so the same checked operation runs inside an isolated helper container.
export async function workspaceOperation(root: string, request: FileRequest): Promise<any> {
  const fs = await import("node:fs/promises"), path = await import("node:path");
  const fail = (code: number, message: string): never => { throw Object.assign(new Error(message), { statusCode: code }); };
  if (!request.path || request.path.includes("\0") || request.path.includes("\\")) fail(422, "Invalid workspace path");
  const base = await fs.realpath(root), candidate = path.resolve(base, request.path.replace(/^\/+/, ""));
  const inside = (file: string) => file === base || file.startsWith(base + path.sep);
  if (!inside(candidate)) fail(403, "Path must stay inside the project workspace");
  let target = candidate;
  try {
    if (request.operation === "delete") {
      if (candidate === base) fail(403, "Cannot delete the workspace root");
      const parent = await fs.realpath(path.dirname(candidate));
      if (!inside(parent)) fail(403, "Symlink escapes the workspace");
      target = path.join(parent, path.basename(candidate));
      const info = await fs.lstat(target);
      if (!info.isSymbolicLink() && !inside(await fs.realpath(target))) fail(403, "Path escapes the workspace");
      await fs.rm(target, { recursive: info.isDirectory(), force: false });
      return { deleted: request.path };
    }
    target = await fs.realpath(candidate);
    if (!inside(target)) fail(403, "Symlink escapes the workspace");
    if (request.operation === "list") {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const files = await Promise.all(entries.slice(0, 5000).map(async entry => {
        const file = path.join(target, entry.name), info = await fs.lstat(file);
        return { name: entry.name, path: path.relative(base, file), kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file", size: info.size, modified_at: info.mtime.toISOString() };
      }));
      files.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
      return { path: path.relative(base, target) || ".", files, truncated: entries.length > 5000 };
    }
    const info = await fs.stat(target);
    if (!info.isFile()) fail(422, "Select a regular file");
    const limit = Math.min(request.limit || 32 * 1024 * 1024, 32 * 1024 * 1024);
    const handle = await fs.open(target, "r");
    try {
      const bytes = Buffer.alloc(Math.min(info.size, limit));
      const result = await handle.read(bytes, 0, bytes.length, 0);
      return { path: path.relative(base, target), content: bytes.subarray(0, result.bytesRead).toString("base64"), size: info.size, truncated: info.size > limit };
    } finally { await handle.close(); }
  } catch (error: any) {
    if (error.code === "ENOENT") fail(404, "Workspace path not found");
    if (error.code === "ENOTDIR") fail(422, "Select a directory");
    throw error;
  }
}

export class DockerWorkspace {
  constructor(private isDeleting: (projectId: string) => boolean = () => false) {}
  private running = new Map<string, Set<Promise<unknown>>>();
  private docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock", timeout: 30000 });
  async run(projectId: string, config: DispatchConfig, request: FileRequest) {
    if (this.isDeleting(projectId)) throw Object.assign(new Error("项目正在删除"), { statusCode: 409 });
    const tasks = this.running.get(projectId) ?? new Set<Promise<unknown>>();
    this.running.set(projectId, tasks);
    const task = this.perform(projectId, config, request);
    tasks.add(task);
    try { return await task; }
    finally { tasks.delete(task); if (!tasks.size) this.running.delete(projectId); }
  }
  async drainProject(projectId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...(this.running.get(projectId) ?? [])]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("工作区文件操作尚未退出，请稍后重试删除")), 35000);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async perform(projectId: string, config: DispatchConfig, request: FileRequest) {
    const volume = `${config.volume_prefix}-workspace-${projectId}`;
    try { await this.docker.getVolume(volume).inspect(); }
    catch (error: any) { if (error.statusCode === 404) throw Object.assign(new Error("工作区尚未创建"), { statusCode: 404 }); throw error; }
    const script = `const run=${workspaceOperation.toString()};try{console.log(JSON.stringify(await run('/workspace',JSON.parse(Buffer.from(process.argv[1],'base64').toString()))))}catch(e){console.log(JSON.stringify({error:e.message,status:e.statusCode||500}));process.exitCode=1}`;
    const helper = await this.docker.createContainer({ Image: config.worker_image, Cmd: ["node", "--input-type=module", "-e", script, Buffer.from(JSON.stringify(request)).toString("base64")],
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], Mounts: [{ Type: "volume", Source: volume, Target: "/workspace", ReadOnly: request.operation !== "delete" }] },
      Labels: { "tessera.workspace-helper": "true", "tessera.project": projectId }, User: "root" });
    try {
      await helper.start();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result;
      try { result = await Promise.race([helper.wait(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Workspace operation timed out")), 30000); timer.unref(); })]); }
      finally { clearTimeout(timer); }
      const raw = await helper.logs({ stdout: true, stderr: false }); let output = "";
      demuxDockerChunk(Buffer.from(raw as Buffer), { pending: Buffer.alloc(0) }, text => { output += text; });
      const data = JSON.parse(output.trim());
      if ((result as any).StatusCode || data.error) throw Object.assign(new Error(data.error || "Workspace operation failed"), { statusCode: data.status || 500 });
      return data;
    } finally { await helper.remove({ force: true }).catch(() => {}); }
  }
}
