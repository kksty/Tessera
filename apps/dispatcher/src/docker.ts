import Docker from "dockerode";
import { setTimeout as sleep } from "node:timers/promises";
import type { DispatchConfig, Job } from "../../../packages/protocol/src/index.js";
import { projectToken } from "../../../packages/protocol/src/internal-auth.js";
import { workerConfig } from "./worker-config.js";
import {
  CallbackSlotRegistry,
  callbackRange,
  callbackSlotCount,
  gatewayEnabled,
  gatewayIdleMilliseconds,
  ProjectGateway,
} from "./gateway.js";

type Gateway = Awaited<ReturnType<ProjectGateway["ensure"]>>;

export interface DemuxState {
  pending: Buffer;
}
/* docker exec 在 Tty:false 下是多路复用流：每帧 = 8 字节头（1 字节流类型 + 3 字节保留 +
   4 字节大端长度）+ 负载。直接把 chunk 当文本拼接会把帧头字节混进正文，
   错误信息因此会出现 "PAPI 409:"、"/API 422:" 之类的乱码前缀。
   这里按帧还原负载，只把正文交给 sink，并返回未凑齐的尾巴留到下一次。 */
export function demuxDockerChunk(chunk: Buffer, state: DemuxState, sink: (text: string) => void): DemuxState {
  let pending = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
  while (pending.length >= 8) {
    const size = pending.readUInt32BE(4);
    if (size > 8 * 1024 * 1024) {
      // 不是多路复用帧（例如已解复用或异常数据），按原文处理
      sink(pending.toString());
      return { pending: Buffer.alloc(0) };
    }
    if (pending.length < 8 + size) break;
    sink(pending.subarray(8, 8 + size).toString());
    pending = pending.subarray(8 + size);
  }
  return { pending };
}

/* compose down/up 会删除并重建 tessera-network，而 Dispatcher 创建的 Worker 容器不归 compose
   管，会带着旧网络 ID 存活。之后 start 它时守护进程报 "failed to set up container networking:
   network <id> not found"：网络 ID 已不存在，重连也无效，只能删容器重建（卷保留）。 */
export function isStaleNetworkError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return /failed to set up container networking/i.test(message) && /network .* not found/i.test(message);
}

export interface JobBackend {
  prepare?(projectId: string, config: DispatchConfig, busy: boolean): Promise<boolean>;
  run(job: Job, config: DispatchConfig, signal: AbortSignal): Promise<void>;
}
export const workerCommand = ["python3", "/opt/tessera/traffic/traffic-launch.py"];
export class DockerBackend implements JobBackend {
  private docker: Docker;
  private streams: Docker;
  private gateway: ProjectGateway;
  constructor(options: Docker.DockerOptions = { socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock" }) {
    this.docker = new Docker({ timeout: 30000, ...options });
    this.gateway = new ProjectGateway(this.docker);
    this.gatewayIdleMs = gatewayIdleMilliseconds();
    // Exec output can be silent throughout a model/tool call. Keep the control API
    // timeout, but never apply it as an idle timeout to the attached execution stream.
    // docker-modem supports a separate timeout until the response headers arrive.
    const streamOptions = { ...options, timeout: 0, connectionTimeout: options.timeout ?? 30000 };
    this.streams = new Docker(streamOptions);
  }
  private creating = new Map<string, Promise<Docker.Container>>();
  private provisioning = new Map<string, Promise<Gateway>>();
  private deleting = new Set<string>();
  private activeRuns = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private callbackSlots = new CallbackSlotRegistry();
  private gatewayIdleMs: number;
  private async volumeExists(name: string) {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return false;
      throw error;
    }
  }
  blockProject(projectId: string) {
    this.deleting.add(projectId);
  }
  isDeleting(projectId: string) {
    return this.deleting.has(projectId);
  }
  async drainCreation(projectId: string) {
    await Promise.allSettled(
      [...this.creating.entries()].filter(([name]) => name.endsWith(`-worker-${projectId}`)).map(([, task]) => task),
    );
    await this.provisioning.get(projectId)?.catch(() => {});
  }
  private beginRun(project: string) {
    this.activeRuns.set(project, (this.activeRuns.get(project) ?? 0) + 1);
    this.lastActivity.set(project, Date.now());
  }
  private endRun(project: string) {
    const remaining = (this.activeRuns.get(project) ?? 1) - 1;
    if (remaining > 0) this.activeRuns.set(project, remaining);
    else this.activeRuns.delete(project);
    this.lastActivity.set(project, Date.now());
  }
  async prepare(projectId: string, config: DispatchConfig, busy: boolean): Promise<boolean> {
    if (this.isDeleting(projectId)) return false;
    // Resolve the new image before touching the old container or its workspace volume.
    const desired = await this.docker.getImage(config.worker_image).inspect();
    const container = this.docker.getContainer(`${config.volume_prefix}-worker-${projectId}`);
    let state: Docker.ContainerInspectInfo;
    try {
      state = await container.inspect();
    } catch (e) {
      if ((e as any).statusCode === 404) return true;
      throw e;
    }
    const signature = gatewayEnabled() ? await this.gateway.signature(projectId, config) : undefined;
    if (state.Image === desired.Id && state.Config?.Labels?.["tessera.gateway-signature"] === signature) return true;
    if (busy) return false;
    for (const id of state.ExecIDs || []) if ((await this.docker.getExec(id).inspect()).Running) return false;
    if (state.State.Running) await container.stop({ t: 5 });
    await container.remove({ v: false });
    return true;
  }
  private async container(job: Job, config: DispatchConfig, gateway?: Gateway) {
    if (this.isDeleting(job.project_id)) throw new Error("项目正在删除");
    const name = `${config.volume_prefix}-worker-${job.project_id}`;
    const existing = this.creating.get(name);
    if (existing) return existing;
    const promise = (async () => {
      const container = this.docker.getContainer(name);
      // 容器和镜像必须分开查：镜像 404 不是容器 404。合在一个 try 里会把「镜像暂时不可见」
      // 当成「容器不存在」，随后对仍然存在的同名容器再 create，得到 409。
      let state: Docker.ContainerInspectInfo | null = null;
      try {
        state = await container.inspect();
      } catch (e) {
        if ((e as any).statusCode !== 404) throw e;
      }
      if (state) {
        const desired = await this.docker.getImage(config.worker_image).inspect();
        if (state.Image !== desired.Id || state.Config?.Labels?.["tessera.gateway-signature"] !== gateway?.signature)
          throw new Error("Worker image changed; waiting for active runs to drain before refreshing the container");
        if (this.isDeleting(job.project_id)) throw new Error("项目正在删除");
        // A container whose workspace volume was deleted cannot start. Remove the
        // container (not its data, which is already gone) and recreate both.
        const volumeName = `${config.volume_prefix}-workspace-${job.project_id}`;
        const mounted = state.Mounts?.find((mount) => mount.Destination === "/workspace")?.Name;
        if (mounted && mounted !== volumeName)
          throw new Error(
            `Worker container uses workspace volume ${mounted}, expected ${volumeName}; refusing to discard it automatically`,
          );
        // Only self-heal when the container itself declares the expected volume.
        // Older/fixture inspect payloads may omit Mounts entirely.
        if (mounted === volumeName && !(await this.volumeExists(volumeName))) {
          if (state.State.Running) await container.stop({ t: 5 }).catch(() => {});
          await container.remove({ v: false }).catch(() => {});
          state = null;
        }
        if (state) {
          if (state.State.Running) return container;
          try {
            await container.start();
            return container;
          } catch (error) {
            if (!isStaleNetworkError(error)) throw error;
            await this.removeZombie(container);
          }
        }
      }
      await this.docker.createVolume({
        Name: `${config.volume_prefix}-workspace-${job.project_id}`,
        Labels: { "tessera.project": job.project_id },
      });
      if (this.isDeleting(job.project_id)) throw new Error("项目正在删除");
      return await this.create(name, config, job.project_id, gateway);
    })();
    this.creating.set(name, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(name);
    }
  }
  /** 在当前网络上创建 Worker 容器；名字被占用仍走 409 复用路径。 */
  private async create(
    name: string,
    config: DispatchConfig,
    projectId: string,
    gateway?: Gateway,
  ): Promise<Docker.Container> {
    const volume = `${config.volume_prefix}-workspace-${projectId}`;
    try {
      const result = await this.docker.createContainer({
        name,
        Image: config.worker_image,
        Cmd: ["sleep", "infinity"],
        WorkingDir: "/workspace",
        Labels: {
          "tessera.project": projectId,
          "tessera.managed": "true",
          ...(gateway ? { "tessera.gateway-signature": gateway.signature } : {}),
        },
        ...(gateway
          ? {
              NetworkingConfig: {
                EndpointsConfig: {
                  [gateway.networkName]: { IPAMConfig: { IPv4Address: gateway.worker } },
                },
              },
            }
          : {}),
        HostConfig: {
          NetworkMode: gateway?.networkName || config.network,
          Mounts: [
            { Type: "volume", Source: volume, Target: "/workspace" },
            ...(gateway
              ? [{ Type: "volume" as const, Source: gateway.ca, Target: "/etc/tessera-ca", ReadOnly: true }]
              : []),
          ],
          // 渗透工具需要原始套接字与网络配置能力：tcpdump、arp-scan，
          // 以及其它需要原始套接字的工具。显式声明，不依赖守护进程默认权能集。
          CapAdd: gateway ? ["NET_RAW"] : ["NET_RAW", "NET_ADMIN"],
          ...(gateway
            ? {
                CapDrop: ["NET_ADMIN"],
                SecurityOpt: ["no-new-privileges:true"],
                Dns: [gateway.gateway],
                Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
              }
            : {}),
        },
        User: "root",
      });
      await result.start();
      return result;
    } catch (error) {
      if ((error as any).statusCode !== 409) throw error;
      // Docker Desktop 重启后恢复容器时，名字可能已被占用、而 inspect 短暂仍返回 404；
      // 另一个 Dispatcher 实例也可能刚刚创建成功。等容器可见后复用它，而不是让任务失败。
      return this.reuseExisting(name, config, projectId, error, gateway);
    }
  }
  /** 删掉网络已失效的残留容器。卷不删：工作区数据由同名卷继续承载。 */
  private async removeZombie(container: Docker.Container) {
    try {
      await container.remove({ v: false, force: true });
    } catch (error) {
      if ((error as any).statusCode !== 404) throw error;
    }
  }
  /** 名字已被占用但 inspect 暂时看不到：等它出现并复用，而不是把任务判失败。 */
  private async reuseExisting(
    name: string,
    config: DispatchConfig,
    projectId: string,
    conflict: unknown,
    gateway?: Gateway,
  ): Promise<Docker.Container> {
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(attempt === 0 ? 100 : 500);
      const container = this.docker.getContainer(name);
      try {
        const state = await container.inspect();
        const desired = await this.docker.getImage(config.worker_image).inspect();
        if (state.Image !== desired.Id || state.Config?.Labels?.["tessera.gateway-signature"] !== gateway?.signature)
          throw new Error(
            "Worker container name is held by a container built from a different image; refusing to reuse it",
          );
        if (state.State.Running) return container;
        try {
          await container.start();
          return container;
        } catch (error) {
          if (!isStaleNetworkError(error)) throw error;
          await this.removeZombie(container);
          return await this.create(name, config, projectId, gateway);
        }
      } catch (error) {
        // 只重试「容器仍不可见」；镜像不符或启动失败是真实错误，直接上抛。
        if ((error as any).statusCode !== 404) throw error;
      }
    }
    throw conflict;
  }
  async run(job: Job, config: DispatchConfig, signal: AbortSignal) {
    this.beginRun(job.project_id);
    let callbackSlot: number | null = null;
    try {
      const safeConfig = await workerConfig(job, config, process.env.TESSERA_WORKER_TOKEN || "");
      const { worker_config: _profile, ...workerJob } = job;
      if (this.isDeleting(job.project_id)) throw new Error("项目正在删除");
      let gateway: Gateway | undefined;
      if (gatewayEnabled()) {
        let task = this.provisioning.get(job.project_id);
        if (!task) {
          task = this.gateway.ensure(job.project_id, config);
          this.provisioning.set(job.project_id, task);
        }
        try {
          gateway = await task;
        } finally {
          if (this.provisioning.get(job.project_id) === task) this.provisioning.delete(job.project_id);
        }
      }
      const container = await this.container(job, config, gateway);
      if (gateway) await this.gateway.route(container, gateway.gateway, job.project_id);
      if (this.isDeleting(job.project_id)) throw new Error("项目正在删除");
      const block = gateway?.callback;
      const slotCount = callbackSlotCount(block, config.max_project_workers || 1);
      callbackSlot = slotCount ? this.callbackSlots.acquire(job.project_id, slotCount) : null;
      if (block && slotCount && callbackSlot === null)
        throw new Error("项目回调端口槽位不足，无法为并发 Run 分配独立端口段");
      const range = block && callbackSlot !== null ? callbackRange(block, slotCount, callbackSlot) : null;
      const callback = range ? { host: block!.host, ...range } : block;
      const exec = await container.exec({
        Cmd: gateway ? ["python3", "/opt/tessera/traffic/gateway-worker.py"] : workerCommand,
        Env: [
          `TESSERA_JOB=${Buffer.from(JSON.stringify(workerJob)).toString("base64")}`,
          `TESSERA_RUN_CONFIG=${Buffer.from(JSON.stringify(safeConfig)).toString("base64")}`,
          `TESSERA_PROJECT_TOKEN=${projectToken(process.env.TESSERA_WORKER_TOKEN || "", job.project_id)}`,
          `TESSERA_CAPTURE_UPSTREAM=${process.env.TESSERA_CAPTURE_UPSTREAM || ""}`,
          `TESSERA_CAPTURE_BYPASS=${process.env.TESSERA_CAPTURE_BYPASS || ""}`,
          `TESSERA_CAPTURE_TLS_MAX=${process.env.TESSERA_CAPTURE_TLS_MAX || ""}`,
          ...(gateway
            ? [
                `TESSERA_GATEWAY_IP=${gateway.gateway}`,
                `TESSERA_CALLBACK_HOST=${callback?.host || ""}`,
                `TESSERA_CALLBACK_PORT_START=${callback?.first || ""}`,
                `TESSERA_CALLBACK_PORT_END=${callback?.last || ""}`,
              ]
            : []),
          // 目录刷新是每个 Runner 进程一次的网络检查；部署显式离线时沿用同一开关，
          // 否则队列会为每次 Run 多等最多 8 秒的目录超时。Pi 只判断变量是否定义，
          // 因此 `PI_OFFLINE=`（空值）也必须原样透传。
          ...(process.env.PI_OFFLINE === undefined ? [] : [`PI_OFFLINE=${process.env.PI_OFFLINE}`]),
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await this.streams.getExec(exec.id).start({ Detach: false, Tty: false });
      let text = "";
      let demux: DemuxState = { pending: Buffer.alloc(0) };
      stream.on("data", (chunk: Buffer) => {
        demux = demuxDockerChunk(chunk, demux, (part) => {
          if (text.length < 10000) text += part;
        });
      });
      const abort = () => {
        void exec
          .inspect()
          .then(async (state) => {
            if (!state.Pid) return;
            const signal = async (name: string) => {
              const result = await container.exec({ Cmd: ["kill", `-${name}`, String(state.Pid)] });
              await result.start({ Detach: true });
            };
            await signal("TERM").catch(() => {});
            // A process that ignores SIGTERM must not keep running after the Run was
            // cancelled. Escalate once, then let the stream close.
            const timer = setTimeout(() => {
              void exec
                .inspect()
                .then(async (current) => {
                  if (current.Running) await signal("KILL");
                })
                .catch(() => {});
            }, 5000);
            timer.unref();
          })
          .catch(() => {});
        stream.destroy(new Error("Job cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await new Promise<void>((resolve, reject) => {
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        const state = await exec.inspect();
        if (state.ExitCode !== 0)
          throw new Error(text.replace(/[\x00-\x08]/g, "").slice(-2000) || `Worker exited ${state.ExitCode}`);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      if (callbackSlot !== null) this.callbackSlots.release(job.project_id, callbackSlot);
      this.endRun(job.project_id);
    }
  }
  /** Reclaim execs left running by an earlier dispatcher process. */
  async recover() {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ["tessera.managed=true"] }),
    });
    for (const listed of containers) {
      const container = this.docker.getContainer(listed.Id);
      const state = await container.inspect().catch(() => null);
      if (!state?.ExecIDs?.length) continue;
      for (const id of state.ExecIDs) {
        const exec = this.docker.getExec(id);
        const info = await exec.inspect().catch(() => null);
        if (!info?.Running || !info.Pid) continue;
        const kill = async (signal: string) => {
          const result = await container.exec({ Cmd: ["kill", `-${signal}`, String(info.Pid)] });
          await result.start({ Detach: true });
        };
        await kill("TERM").catch(() => {});
        const timer = setTimeout(() => {
          void exec
            .inspect()
            .then(async (current) => {
              if (current.Running) await kill("KILL");
            })
            .catch(() => {});
        }, 5000);
        timer.unref();
      }
    }
  }
  async suspend(projectId: string, config: DispatchConfig) {
    try {
      const c = this.docker.getContainer(`${config.volume_prefix}-worker-${projectId}`);
      const info = await c.inspect();
      if (info.State.Running) await c.stop({ t: 3 });
    } catch (e) {
      if ((e as any).statusCode !== 404) throw e;
    }
    if (gatewayEnabled()) await this.gateway.stop(projectId, config);
  }
  async reconcile(activeIds: string[], config: DispatchConfig) {
    const active = new Set(activeIds);
    const containers = await this.docker.listContainers({
      filters: JSON.stringify({ label: ["tessera.managed=true"] }),
    });
    for (const c of containers) {
      const pid = c.Labels["tessera.project"];
      if (pid && !active.has(pid) && c.Names.some((n) => n.startsWith(`/${config.volume_prefix}-worker-`))) {
        await this.docker.getContainer(c.Id).stop({ t: 3 });
        if (gatewayEnabled()) await this.gateway.stop(pid, config);
      }
    }
    if (gatewayEnabled()) {
      const now = Date.now();
      const gateways = await this.docker.listContainers({
        filters: JSON.stringify({ label: ["tessera.gateway-resource=true"] }),
      });
      for (const gateway of gateways) {
        const project = gateway.Labels["tessera.project"];
        if (!project || !gateway.Names.includes(`/${config.volume_prefix}-gateway-${project}`)) continue;
        if (!active.has(project)) {
          await this.gateway.stop(project, config);
          continue;
        }
        // A project can stay "active" for a long time between Runs; do not keep a
        // mitmproxy process resident while it has no traffic. The next Run restarts it.
        if (
          this.gatewayIdleMs > 0 &&
          !this.activeRuns.get(project) &&
          now - (this.lastActivity.get(project) ?? 0) >= this.gatewayIdleMs
        )
          await this.gateway.stop(project, config);
      }
    }
  }
}
