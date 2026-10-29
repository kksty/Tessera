import Docker from "dockerode";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DispatchConfig } from "../../../../packages/protocol/src/index.js";
import { projectToken } from "../../../../packages/protocol/src/internal-auth.js";
import { allocateCallback, callbackPolicy, type CallbackAllocation } from "./callbacks.js";
import { ingressConfig } from "./ingress.js";
import { gatewayNames } from "./settings.js";
import {
  GATEWAY_SUBNET_BITS,
  gatewaySubnetPool,
  networkAddresses,
  nextFreeSubnet,
  subnetRange,
  subnetsOverlap,
} from "./subnet.js";

const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;

type GatewayNames = ReturnType<typeof gatewayNames>;
type GatewayAddresses = ReturnType<typeof networkAddresses>;

/**
 * One isolated routing namespace per project. The gateway is the only component with
 * NET_ADMIN; the model never receives its volumes, capabilities or routing controls.
 *
 * The class is a thin Docker orchestrator: network, volumes and container are each
 * ensured by a focused helper, and every helper validates ownership before reusing
 * anything it did not create.
 */
export class ProjectGateway {
  constructor(private docker: Docker) {}
  private allocation: Promise<unknown> = Promise.resolve();

  /** Fingerprint of everything a gateway container is built from, so image/config drift recreates it once. */
  async signature(project: string, config: DispatchConfig) {
    const image = await this.docker.getImage(process.env.TESSERA_GATEWAY_IMAGE!).inspect();
    if (process.env.TESSERA_CAPTURE_UPSTREAM || process.env.TESSERA_CAPTURE_BYPASS)
      throw new Error(
        "Gateway mode does not accept legacy CAPTURE_UPSTREAM/BYPASS; configure routing on the gateway uplink instead",
      );
    return createHash("sha256")
      .update(
        JSON.stringify([
          "gateway-v1",
          image.Id,
          config.network,
          config.server,
          config.capture_enabled !== false,
          process.env.TESSERA_CAPTURE_TLS_MAX || "TLS1_2",
          callbackPolicy(),
          ingressConfig(),
          projectToken(process.env.TESSERA_WORKER_TOKEN || "", project),
        ]),
      )
      .digest("hex");
  }

  async ensure(project: string, config: DispatchConfig) {
    // Keep port reservations deterministic when multiple projects first start together.
    const task = this.allocation.then(() => this.ensureProject(project, config));
    this.allocation = task.catch(() => {});
    return task;
  }

  private async ensureProject(project: string, config: DispatchConfig) {
    if (!config.network || ["host", "none"].includes(config.network) || config.network.startsWith("container:"))
      throw new Error("Project gateway uplink must be a Docker bridge network");
    const names = gatewayNames(config.volume_prefix, project);
    const signature = await this.signature(project, config);
    const labels = {
      "tessera.project": project,
      "tessera.gateway-resource": "true",
      "tessera.gateway-image": process.env.TESSERA_GATEWAY_IMAGE!,
    };
    const bridge = `ts${createHash("sha256").update(names.network).digest("hex").slice(0, 12)}`;
    const pool = gatewaySubnetPool();
    const network = await this.ensureNetwork(names.network, labels, bridge, pool);
    const subnet = network.IPAM?.Config?.[0]?.Subnet || "";
    let bits = -1;
    try {
      bits = subnetRange(subnet).bits;
    } catch {}
    if (
      network.Labels?.["tessera.project"] !== project ||
      network.Labels?.["tessera.gateway-resource"] !== "true" ||
      !network.Internal ||
      network.EnableIPv6 ||
      network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
      network.Options?.["com.docker.network.bridge.name"] !== bridge ||
      bits !== GATEWAY_SUBNET_BITS ||
      !subnetsOverlap(subnet, pool)
    )
      throw new Error(
        `Project network is not an owned /${GATEWAY_SUBNET_BITS} isolated network from ${pool}; delete the project network once to migrate`,
      );
    const addresses = networkAddresses(subnet);
    await bridgeForwarding(this.docker, process.env.TESSERA_GATEWAY_IMAGE!, project, bridge, true);
    await this.ensureVolumes(names, project, labels);
    const { container, callback, running } = await this.ensureContainer(
      project,
      config,
      names,
      labels,
      signature,
      addresses,
    );
    const callbackWidth = callback ? callback.last - callback.first + 1 : 0;
    const concurrent = config.max_project_workers || 1;
    if (callbackWidth && callbackWidth < concurrent)
      throw new Error(
        `TESSERA_CALLBACK_BLOCK_SIZE=${callbackWidth} is smaller than max_project_workers=${concurrent}; raise the block so every concurrent Run gets a disjoint callback range`,
      );
    if (!running) await container.start();
    await this.waitHealthy(container, names.gateway);
    return { ...names, ...addresses, networkName: names.network, signature, callback };
  }

  /** Ensure the project's isolated /29 bridge network exists and is owned by this project. */
  private async ensureNetwork(networkName: string, labels: Record<string, string>, bridge: string, pool: string) {
    let network = await this.docker
      .getNetwork(networkName)
      .inspect()
      .catch((error) => {
        if (missing(error)) return null;
        throw error;
      });
    if (!network) {
      const used = (await this.docker.listNetworks()).flatMap((item) =>
        (item.IPAM?.Config ?? []).map((entry) => entry.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
      );
      const subnet = nextFreeSubnet(pool, GATEWAY_SUBNET_BITS, used);
      await this.docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
        Options: {
          "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
          "com.docker.network.bridge.name": bridge,
        },
        Labels: labels,
      });
      network = await this.docker.getNetwork(networkName).inspect();
    }
    return network;
  }

  /** Ensure the CA and traffic-data volumes exist and carry the project's ownership labels. */
  private async ensureVolumes(names: GatewayNames, project: string, labels: Record<string, string>) {
    for (const name of [names.ca, names.data]) {
      const volume = await this.docker
        .getVolume(name)
        .inspect()
        .catch((error) => {
          if (missing(error)) return null;
          throw error;
        });
      if (
        volume &&
        (volume.Labels?.["tessera.project"] !== project || volume.Labels?.["tessera.gateway-resource"] !== "true")
      )
        throw new Error(`Gateway volume ownership mismatch: ${name}`);
      if (!volume) await this.docker.createVolume({ Name: name, Labels: labels });
    }
  }

  /**
   * Ensure the gateway container matches the current signature. A stale container is
   * removed and rebuilt; callback ports are retained across image updates when the
   * pool policy allows, and never reused when they would overlap another project.
   */
  private async ensureContainer(
    project: string,
    config: DispatchConfig,
    names: GatewayNames,
    labels: Record<string, string>,
    signature: string,
    addresses: GatewayAddresses,
  ) {
    let container = this.docker.getContainer(names.gateway);
    let state = await container.inspect().catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    if (
      state &&
      (state.Config.Labels?.["tessera.project"] !== project ||
        state.Config.Labels?.["tessera.gateway-resource"] !== "true")
    )
      throw new Error("Gateway container ownership mismatch");
    let callback: CallbackAllocation | null = JSON.parse(state?.Config.Labels?.["tessera.callback"] || "null");
    if (state && state.Config.Labels?.["tessera.gateway-signature"] !== signature) {
      if (state.State.Running) await container.stop({ t: 5 });
      await container.remove({ v: false });
      state = null;
    }
    if (!state) {
      const explicit = ingressConfig();
      const policy = callbackPolicy();
      const existing = await this.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: ["tessera.gateway-resource=true"] }),
      });
      const reserved: CallbackAllocation[] = existing
        .filter((item) => item.Labels["tessera.project"] !== project)
        .flatMap((item) => {
          const value = JSON.parse(item.Labels["tessera.callback"] || "null");
          return value ? [value] : [];
        });
      for (const entries of Object.values(explicit))
        for (const entry of entries) reserved.push({ host: "", first: entry.host_port, last: entry.host_port });
      // Retain the project's block across image updates, but never retain an overlap or a block outside a changed pool.
      if (!policy.host || explicit[project]?.length) callback = null;
      else if (
        !callback ||
        callback.first < policy.first ||
        callback.last > policy.last ||
        callback.last - callback.first + 1 !== policy.size ||
        reserved.some((item) => callback!.first <= item.last && callback!.last >= item.first)
      )
        callback = allocateCallback(policy, reserved);
      if (callback) callback.host = policy.host;
      const ingress = [...(explicit[project] || [])];
      if (callback)
        for (let p = callback.first; p <= callback.last; p++)
          for (const protocol of ["tcp", "udp"] as const)
            ingress.push({ host_port: p, worker_port: p, protocol, bind: policy.bind });
      const ports: Docker.PortMap = {};
      for (const entry of ingress) {
        const key = `${entry.worker_port}/${entry.protocol}`;
        (ports[key] ||= []).push({ HostIp: entry.bind, HostPort: String(entry.host_port) });
      }
      container = await this.docker.createContainer({
        name: names.gateway,
        Image: process.env.TESSERA_GATEWAY_IMAGE,
        Labels: { ...labels, "tessera.gateway-signature": signature, "tessera.callback": JSON.stringify(callback) },
        Env: [
          `TESSERA_GATEWAY_IP=${addresses.gateway}`,
          `TESSERA_WORKER_IP=${addresses.worker}`,
          `TESSERA_CAPTURE_SERVER=${config.server}`,
          `TESSERA_CAPTURE_PROJECT=${project}`,
          `TESSERA_PROJECT_TOKEN=${projectToken(process.env.TESSERA_WORKER_TOKEN || "", project)}`,
          `TESSERA_CAPTURE_ENABLED=${config.capture_enabled !== false ? "1" : "0"}`,
          `TESSERA_CAPTURE_TLS_MAX=${process.env.TESSERA_CAPTURE_TLS_MAX || "TLS1_2"}`,
          `TESSERA_CONNTRACK_MIN=${process.env.TESSERA_CONNTRACK_MIN || "262144"}`,
          `TESSERA_INGRESS=${JSON.stringify(ingress)}`,
        ],
        ExposedPorts: Object.fromEntries(Object.keys(ports).map((key) => [key, {}])),
        HostConfig: {
          NetworkMode: config.network,
          CapAdd: ["NET_ADMIN"],
          RestartPolicy: { Name: "unless-stopped" },
          PortBindings: ports,
          Sysctls: {
            "net.ipv4.ip_forward": "1",
            "net.ipv4.conf.all.send_redirects": "0",
            "net.ipv6.conf.all.disable_ipv6": "1",
          },
          Mounts: [
            { Type: "volume", Source: names.ca, Target: "/public-ca" },
            { Type: "volume", Source: names.data, Target: "/var/lib/tessera-proxy" },
          ],
        },
      });
      await this.docker
        .getNetwork(names.network)
        .connect({ Container: container.id, EndpointConfig: { IPAMConfig: { IPv4Address: addresses.gateway } } });
    }
    return { container, callback, running: Boolean(state?.State.Running) };
  }

  /** Wait for Docker health, failing closed: an unready gateway never lets a Worker start. */
  private async waitHealthy(container: Docker.Container, gatewayName: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = await container.inspect();
      if (current.State.Health?.Status === "healthy") return;
      if (current.State.Health?.Status === "unhealthy" || current.State.Status === "exited") break;
      await sleep(500);
    }
    throw new Error(`Project gateway is not ready: ${gatewayName}; Worker will not start a Run`);
  }

  async route(worker: Docker.Container, gatewayIp: string, project: string) {
    // Privilege belongs to a short-lived trusted helper, never to docker exec in the Worker.
    const helper = await this.docker.createContainer({
      Image: process.env.TESSERA_GATEWAY_IMAGE,
      Entrypoint: ["ip"],
      Cmd: ["route", "replace", "default", "via", gatewayIp],
      Labels: { "tessera.project": project, "tessera.gateway-helper": "true" },
      HostConfig: { NetworkMode: `container:${worker.id}`, CapDrop: ["ALL"], CapAdd: ["NET_ADMIN"] },
    });
    try {
      await helper.start();
      const result = await helper.wait();
      if (result.StatusCode !== 0) throw new Error("Unable to route Worker through its gateway");
    } finally {
      await helper.remove({ force: true, v: false });
    }
  }

  async stop(project: string, config: DispatchConfig) {
    const container = this.docker.getContainer(gatewayNames(config.volume_prefix, project).gateway);
    const info = await container.inspect().catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    if (
      info?.Config.Labels?.["tessera.gateway-resource"] === "true" &&
      info.Config.Labels["tessera.project"] === project &&
      info.State.Running
    )
      await container.stop({ t: 5 });
  }
}

/** Docker internal-network filters also see routed IP packets crossing the same L2 bridge.
 * Permit only that same-bridge hop (Worker <-> router), never bridge-to-host/uplink forwarding.
 * A trusted short-lived helper owns this host operation; no Worker gets host networking.
 */
export async function bridgeForwarding(
  docker: Docker,
  image: string,
  project: string,
  bridge: string,
  install: boolean,
) {
  if (!/^ts[0-9a-f]{12}$/.test(bridge)) throw new Error("Invalid managed bridge name");
  const helper = await docker.createContainer({
    Image: image,
    Cmd: ["python3", "/opt/tessera/traffic/gateway-bridge.py", bridge, install ? "install" : "remove"],
    Labels: { "tessera.project": project, "tessera.gateway-helper": "true", "tessera.gateway-host-rule": "true" },
    HostConfig: { NetworkMode: "host", CapDrop: ["ALL"], CapAdd: ["NET_ADMIN", "NET_RAW"] },
  });
  try {
    await helper.start();
    const result = await helper.wait();
    if (result.StatusCode !== 0)
      throw new Error("Gateway bridge setup failed; Docker's iptables backend with DOCKER-USER is required");
  } finally {
    await helper.remove({ force: true, v: false });
  }
}
