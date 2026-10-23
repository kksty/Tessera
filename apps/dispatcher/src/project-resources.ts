import Docker from "dockerode";

const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;
const conflict = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 409 }); };

/** Only the exact project-owned worker, workspace and workspace helpers may be removed. Never prune. */
export async function deleteProjectResources(docker: Docker, projectId: string, prefix: string) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(projectId) || !/^[a-zA-Z0-9_.-]+$/.test(prefix)) conflict("项目资源标识无效");
  const owned = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`tessera.project=${projectId}`] }) });
  const ownedVolumes = await docker.listVolumes({ filters: JSON.stringify({ label: [`tessera.project=${projectId}`] }) });
  // A deployment prefix may have changed since the worker was created. Recover the
  // actual resource names from the project labels and managed-name suffix instead
  // of treating the old resources as foreign and blocking deletion forever.
  const workerSuffix = `-worker-${projectId}`, volumeSuffix = `-workspace-${projectId}`;
  const containerCandidates = owned.filter(item =>
    item.Labels?.["tessera.managed"] === "true" && item.Names.some(name => name.endsWith(workerSuffix)));
  const volumeCandidates = (ownedVolumes.Volumes ?? []).filter(item => item.Name.endsWith(volumeSuffix));
  if (containerCandidates.length > 1) conflict("发现多个匹配的项目 Worker 容器，归属需核实；项目保留");
  if (volumeCandidates.length > 1) conflict("发现多个匹配的项目工作区卷，归属需核实；项目保留");
  const containerName = containerCandidates.length
    ? containerCandidates[0].Names.find(name => name.endsWith(workerSuffix))!.replace(/^\//, "")
    : `${prefix}-worker-${projectId}`;
  const volumeName = volumeCandidates.length ? volumeCandidates[0].Name : `${prefix}-workspace-${projectId}`;
  const container = docker.getContainer(containerName), volume = docker.getVolume(volumeName);
  const info = await container.inspect().catch(error => { if (missing(error)) return null; throw error; });
  const volumeInfo = await volume.inspect().catch(error => { if (missing(error)) return null; throw error; });
  if ((ownedVolumes.Volumes ?? []).some(item => item.Name !== volumeName))
    conflict("发现其他名称的关联卷，归属需核实；项目保留，请先检查资源前缀");
  if (info && (info.Config.Labels?.["tessera.project"] !== projectId || info.Config.Labels?.["tessera.managed"] !== "true" ||
      info.Name !== `/${containerName}` || info.Mounts.some(m => m.Type !== "volume" || m.Name !== volumeName || m.Destination !== "/workspace")))
    conflict(`容器 ${containerName} 的归属或挂载不符合项目记录，未执行删除`);
  if (volumeInfo && volumeInfo.Labels?.["tessera.project"] !== projectId)
    conflict(`卷 ${volumeName} 缺少匹配的项目标签，未执行删除`);

  const all = await docker.listContainers({ all: true });
  const references = all.filter(item => item.Mounts?.some(m => m.Type === "volume" && m.Name === volumeName));
  const helpers = references.filter(item => item.Id !== info?.Id && item.Labels?.["tessera.workspace-helper"] === "true" &&
    (!item.Labels["tessera.project"] || item.Labels["tessera.project"] === projectId) &&
    item.Mounts.length === 1 && item.Mounts.every(m => m.Type === "volume" && m.Name === volumeName && m.Destination === "/workspace"));
  const allowedIds = new Set([...(info ? [info.Id] : []), ...helpers.map(item => item.Id)]);
  const foreign = [...owned, ...references].filter(item => !allowedIds.has(item.Id));
  if (foreign.length) conflict(`关联资源仍有归属异常或其他容器引用：${[...new Set(foreign.map(item => item.Names.join(",")))].join("、")}；项目保留，未执行删除`);

  // Preflight above completes before stopping/removing any resource. Use immutable IDs after inspection.
  for (const id of [...helpers.map(item => item.Id), ...(info ? [info.Id] : [])]) {
    const target = docker.getContainer(id);
    const current = await target.inspect().catch(error => { if (missing(error)) return null; throw error; });
    if (!current) continue;
    if (current.State.Running) await target.stop({ t: 5 }).catch(error => { if (!missing(error) && error.statusCode !== 304) throw error; });
    await target.remove({ v: false }).catch(error => { if (!missing(error)) throw error; });
  }
  // No force: Docker refuses if a concurrent/unexpected container acquired a reference.
  if (volumeInfo) await volume.remove().catch(error => { if (!missing(error)) throw error; });
  return { container: containerName, workspace_volume: volumeName, resources_deleted: true as const };
}
