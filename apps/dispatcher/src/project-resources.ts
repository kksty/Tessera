import Docker from "dockerode";
import { bridgeForwarding } from "./gateway.js";

const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;
const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 409 });
};

/** Only the exact project-owned worker, workspace and workspace helpers may be removed. Never prune. */
export async function deleteProjectResources(docker: Docker, projectId: string, prefix: string) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(projectId) || !/^[a-zA-Z0-9_.-]+$/.test(prefix)) conflict("项目资源标识无效");
  const owned = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`tessera.project=${projectId}`] }),
  });
  const ownedVolumes = await docker.listVolumes({
    filters: JSON.stringify({ label: [`tessera.project=${projectId}`] }),
  });
  const ownedNetworks = await docker.listNetworks({
    filters: JSON.stringify({ label: [`tessera.project=${projectId}`] }),
  });
  // A deployment prefix may have changed since the worker was created. Recover the
  // actual resource names from the project labels and managed-name suffix instead
  // of treating the old resources as foreign and blocking deletion forever.
  const workerSuffix = `-worker-${projectId}`,
    volumeSuffix = `-workspace-${projectId}`;
  const containerCandidates = owned.filter(
    (item) => item.Labels?.["tessera.managed"] === "true" && item.Names.some((name) => name.endsWith(workerSuffix)),
  );
  const volumeCandidates = (ownedVolumes.Volumes ?? []).filter((item) => item.Name.endsWith(volumeSuffix));
  if (containerCandidates.length > 1) conflict("发现多个匹配的项目 Worker 容器，归属需核实；项目保留");
  if (volumeCandidates.length > 1) conflict("发现多个匹配的项目工作区卷，归属需核实；项目保留");
  const containerName = containerCandidates.length
    ? containerCandidates[0].Names.find((name) => name.endsWith(workerSuffix))!.replace(/^\//, "")
    : `${prefix}-worker-${projectId}`;
  const volumeName = volumeCandidates.length ? volumeCandidates[0].Name : `${prefix}-workspace-${projectId}`;
  const gatewayContainers = owned.filter(
    (item) =>
      item.Labels?.["tessera.gateway-resource"] === "true" &&
      item.Names.some((name) => name.endsWith(`-gateway-${projectId}`)),
  );
  const gatewayVolumes = (ownedVolumes.Volumes ?? []).filter(
    (item) =>
      item.Labels?.["tessera.gateway-resource"] === "true" &&
      [`-gateway-ca-${projectId}`, `-gateway-data-${projectId}`].some((suffix) => item.Name.endsWith(suffix)),
  );
  const gatewayHelpers = owned.filter((item) => item.Labels?.["tessera.gateway-helper"] === "true");
  const caVolumes = gatewayVolumes
    .filter((item) => item.Name.endsWith(`-gateway-ca-${projectId}`))
    .map((item) => item.Name);
  const container = docker.getContainer(containerName),
    volume = docker.getVolume(volumeName);
  const info = await container.inspect().catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  const volumeInfo = await volume.inspect().catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if ((ownedVolumes.Volumes ?? []).some((item) => item.Name !== volumeName && !gatewayVolumes.includes(item)))
    conflict("发现其他名称的关联卷，归属需核实；项目保留，请先检查资源前缀");
  if (
    info &&
    (info.Config.Labels?.["tessera.project"] !== projectId ||
      info.Config.Labels?.["tessera.managed"] !== "true" ||
      info.Name !== `/${containerName}` ||
      info.Mounts.some(
        (m) =>
          m.Type !== "volume" ||
          !(
            (m.Name === volumeName && m.Destination === "/workspace") ||
            (caVolumes.includes(m.Name!) && m.Destination === "/etc/tessera-ca" && m.RW === false)
          ),
      ))
  )
    conflict(`容器 ${containerName} 的归属或挂载不符合项目记录，未执行删除`);
  if (volumeInfo && volumeInfo.Labels?.["tessera.project"] !== projectId)
    conflict(`卷 ${volumeName} 缺少匹配的项目标签，未执行删除`);

  const all = await docker.listContainers({ all: true });
  const gatewayVolumeNames = new Set(gatewayVolumes.map((item) => item.Name));
  for (const item of [...gatewayContainers, ...gatewayHelpers]) {
    const state = await docker.getContainer(item.Id).inspect();
    if (
      state.Config.Labels?.["tessera.project"] !== projectId ||
      state.Mounts.some(
        (m) =>
          m.Type !== "volume" ||
          !gatewayVolumeNames.has(m.Name!) ||
          !(
            (m.Name!.endsWith(`-gateway-ca-${projectId}`) && m.Destination === "/public-ca") ||
            (m.Name!.endsWith(`-gateway-data-${projectId}`) && m.Destination === "/var/lib/tessera-proxy")
          ),
      )
    )
      conflict("网关容器挂载或归属不符；项目保留");
    if (
      gatewayHelpers.includes(item) &&
      (state.Mounts.length ||
        (!(state.Config.Labels?.["tessera.gateway-host-rule"] === "true" && state.HostConfig.NetworkMode === "host") &&
          (!info || state.HostConfig.NetworkMode !== `container:${info.Id}`)))
    )
      conflict("网络初始化容器归属不符；项目保留");
  }
  const references = all.filter((item) => item.Mounts?.some((m) => m.Type === "volume" && m.Name === volumeName));
  const helpers = references.filter(
    (item) =>
      item.Id !== info?.Id &&
      item.Labels?.["tessera.workspace-helper"] === "true" &&
      (!item.Labels["tessera.project"] || item.Labels["tessera.project"] === projectId) &&
      item.Mounts.length === 1 &&
      item.Mounts.every((m) => m.Type === "volume" && m.Name === volumeName && m.Destination === "/workspace"),
  );
  const allowedIds = new Set([
    ...(info ? [info.Id] : []),
    ...helpers.map((item) => item.Id),
    ...gatewayContainers.map((item) => item.Id),
    ...gatewayHelpers.map((item) => item.Id),
  ]);
  if (all.some((item) => !allowedIds.has(item.Id) && item.Mounts?.some((m) => gatewayVolumeNames.has(m.Name!))))
    conflict("其他容器仍引用网关卷；项目保留");
  const networks = [];
  for (const item of ownedNetworks) {
    const state = await docker.getNetwork(item.Id).inspect();
    if (
      !state.Name.endsWith(`-isolated-${projectId}`) ||
      state.Labels?.["tessera.gateway-resource"] !== "true" ||
      state.Labels?.["tessera.project"] !== projectId ||
      !/^ts[0-9a-f]{12}$/.test(state.Options?.["com.docker.network.bridge.name"] || "") ||
      Object.keys(state.Containers || {}).some((id) => !allowedIds.has(id))
    )
      conflict("项目网络归属或连接不符；项目保留");
    await docker
      .getImage(
        state.Labels?.["tessera.gateway-image"] || process.env.TESSERA_GATEWAY_IMAGE || "tessera-gateway:latest",
      )
      .inspect();
    networks.push(state);
  }
  const foreign = [...owned, ...references].filter((item) => !allowedIds.has(item.Id));
  if (foreign.length)
    conflict(
      `关联资源仍有归属异常或其他容器引用：${[...new Set(foreign.map((item) => item.Names.join(",")))].join("、")}；项目保留，未执行删除`,
    );

  // Preflight above completes before stopping/removing any resource. Use immutable IDs after inspection.
  for (const id of [
    ...helpers.map((item) => item.Id),
    ...gatewayHelpers.map((item) => item.Id),
    ...(info ? [info.Id] : []),
    ...gatewayContainers.map((item) => item.Id),
  ]) {
    const target = docker.getContainer(id);
    const current = await target.inspect().catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!current) continue;
    if (current.State.Running)
      await target.stop({ t: 5 }).catch((error) => {
        if (!missing(error) && error.statusCode !== 304) throw error;
      });
    await target.remove({ v: false }).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
  // No force: Docker refuses if a concurrent/unexpected container acquired a reference.
  if (volumeInfo)
    await volume.remove().catch((error) => {
      if (!missing(error)) throw error;
    });
  for (const name of gatewayVolumeNames)
    await docker
      .getVolume(name)
      .remove()
      .catch((error) => {
        if (!missing(error)) throw error;
      });
  for (const network of networks) {
    const bridge = network.Options?.["com.docker.network.bridge.name"];
    if (bridge)
      await bridgeForwarding(
        docker,
        network.Labels?.["tessera.gateway-image"] || process.env.TESSERA_GATEWAY_IMAGE || "tessera-gateway:latest",
        projectId,
        bridge,
        false,
      );
    await docker
      .getNetwork(network.Id)
      .remove()
      .catch((error) => {
        if (!missing(error)) throw error;
      });
  }
  return { container: containerName, workspace_volume: volumeName, resources_deleted: true as const };
}
