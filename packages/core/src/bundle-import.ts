import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DiagnosticRecords } from "./diagnostics.js";
import { DomainError } from "./errors.js";
import { GraphStorage } from "./graph-storage.js";
import { activePeers } from "./swarm.js";
import { readZip, safeArchiveName } from "./archive.js";
import type { Store } from "./store.js";
import type { Run } from "../../protocol/src/index.js";
import {
  BUNDLE_MAX_ENTRY_BYTES,
  BundleImportResult,
  BundleManifest,
  SpoolEntry,
  bundleGraph,
  bundleTempRoot,
  cleanStaleBundles,
  cleanStaleStaging,
  ensureDirectory,
  forEachRow,
  insertRows,
  manifestSchema,
  sha256,
} from "./bundle-shared.js";

/**
 * Restore a project from a bundle into this instance. The original project id is
 * preserved; an existing project or tombstone with that id refuses the import so a
 * bundle can never silently overwrite live work.
 */
export async function importProjectBundle(store: Store, file: string): Promise<BundleImportResult> {
  // Instantiating the recorder creates the diagnostics tables on a bare instance.
  new DiagnosticRecords(store.db);
  cleanStaleStaging(store);
  const root = ensureDirectory(bundleTempRoot(store)),
    spool = mkdtempSync(join(root, "import-"));
  cleanStaleBundles(root);
  let staging: string | undefined;
  try {
    const entries: SpoolEntry[] = [];
    const uncompressedLimit = Number(process.env.TESSERA_IMPORT_MAX_UNCOMPRESSED_BYTES || 64 * 1024 * 1024 * 1024);
    await readZip(
      file,
      (name, bytes) => {
        if (bytes.length > BUNDLE_MAX_ENTRY_BYTES) throw new DomainError(413, `备份条目 ${name} 过大`);
        const path = join(spool, `${String(entries.length).padStart(6, "0")}.bin`);
        writeFileSync(path, bytes, { mode: 0o600 });
        entries.push({ name, path, size: bytes.length, sha256: sha256(bytes) });
      },
      { maxTotalBytes: Number.isFinite(uncompressedLimit) && uncompressedLimit > 0 ? uncompressedLimit : undefined },
    );
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    if (!manifestEntry) throw new DomainError(422, "备份缺少 manifest.json");
    let manifest: BundleManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestEntry.path, "utf8")));
    } catch (error) {
      throw new DomainError(422, `备份清单无效：${error instanceof Error ? error.message : "parse failed"}`);
    }
    for (const name of Object.keys(manifest.files))
      if (!safeArchiveName(name)) throw new DomainError(422, `备份清单包含非法条目名：${name}`);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.name === "manifest.json") continue;
      const expected = manifest.files[entry.name];
      if (!expected) throw new DomainError(422, `备份包含清单未登记的条目：${entry.name}`);
      if (entry.sha256 !== expected) throw new DomainError(422, `备份条目校验和不匹配：${entry.name}`);
      seen.add(entry.name);
    }
    for (const name of Object.keys(manifest.files))
      if (!seen.has(name)) throw new DomainError(422, `备份缺少清单登记的条目：${name}`);
    const projectId = manifest.project.id;
    if (store.db.prepare("SELECT 1 FROM platform_projects WHERE id=?").get(projectId))
      throw new DomainError(409, `项目 ${projectId} 已存在；请先删除或使用其他实例导入`);
    if (store.db.prepare("SELECT 1 FROM platform_tombstones WHERE id=?").get(projectId))
      throw new DomainError(409, `项目 ${projectId} 已被删除并留下墓碑记录，不能恢复同一 ID`);
    const graphEntry = entries.find((entry) => entry.name === "graph.json");
    if (!graphEntry) throw new DomainError(422, "备份缺少 graph.json");
    const graph = bundleGraph(JSON.parse(readFileSync(graphEntry.path, "utf8")));
    if (graph.project.id !== projectId) throw new DomainError(422, "备份的项目 ID 与 graph.json 不一致");
    if (manifest.project.title !== graph.project.title || manifest.project.status !== graph.project.status)
      throw new DomainError(422, "备份清单与 graph.json 的项目头不一致");
    const evidenceEntries = entries.filter((entry) => entry.name.startsWith("evidence/"));
    const evidenceNames = new Set(evidenceEntries.map((entry) => entry.name));
    const evidenceMeta = new Map(graph.evidence.map((evidence) => [evidence.id, evidence]));
    const missing = new Set(manifest.missing_evidence);
    for (const entry of evidenceEntries) {
      const id = entry.name.slice("evidence/".length),
        metadata = evidenceMeta.get(id);
      if (!metadata) throw new DomainError(422, `备份包含图中不存在的证据文件：${id}`);
      if (entry.size !== metadata.size || entry.sha256 !== metadata.sha256)
        throw new DomainError(409, `证据 ${id} 的原件与元数据不一致`);
    }
    for (const evidence of graph.evidence)
      if (!missing.has(evidence.id) && !evidenceNames.has(`evidence/${evidence.id}`))
        throw new DomainError(422, `备份缺少证据原件：${evidence.id}`);
    const target = join(store.evidenceRoot, projectId);
    if (existsSync(target)) throw new DomainError(409, `项目 ${projectId} 的证据目录已存在；请先清理旧目录`);
    const stagingPath = join(store.evidenceRoot, `.import-${randomUUID()}`);
    staging = stagingPath;
    mkdirSync(stagingPath, { recursive: true });
    const move = (from: string, to: string) => {
      mkdirSync(dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        copyFileSync(from, to);
        rmSync(from, { force: true });
      }
    };
    for (const entry of evidenceEntries) move(entry.path, join(stagingPath, entry.name.slice("evidence/".length)));
    for (const entry of entries.filter((candidate) => candidate.name.startsWith("traffic-bodies/"))) {
      const bodyId = entry.name.slice("traffic-bodies/".length);
      store.traffic.bodyPath(projectId, bodyId);
      move(entry.path, join(stagingPath, "traffic-bodies", bodyId));
      chmodSync(join(stagingPath, "traffic-bodies", bodyId), 0o600);
    }
    const importedAt = new Date().toISOString(),
      warnings = [...manifest.warnings];
    let result: BundleImportResult | undefined;
    try {
      store.transaction(() => {
        if (store.db.prepare("SELECT 1 FROM platform_projects WHERE id=?").get(projectId))
          throw new DomainError(409, `项目 ${projectId} 已存在；请先删除或使用其他实例导入`);
        // Runs that were in flight in the source instance cannot resume here.
        new GraphStorage(store.db).save(graph);
        if (store.get(projectId).project.id !== projectId) throw new DomainError(500, "项目导入校验失败");
        insertRows(
          store,
          "INSERT INTO platform_runs(id,project_id,worker,kind,node_id,status,data) VALUES(?,?,?,?,?,?,?)",
          entries,
          "runs",
          projectId,
          (row) => {
            const run = JSON.parse(String(row.data)) as Run;
            if (run.status === "running") {
              run.status = "interrupted";
              run.finished_at = importedAt;
              run.error = "Import: run was still in flight when the project was exported";
            }
            return [row.id, projectId, row.worker, row.kind, row.node_id ?? null, run.status, JSON.stringify(run)];
          },
        );
        insertRows(
          store,
          "INSERT INTO platform_run_models(run_id,data) VALUES(?,?)",
          entries,
          "run-models",
          projectId,
          (row) => [row.run_id, row.data],
        );
        insertRows(
          store,
          "INSERT INTO platform_request_usage(run_id,request_id,data) VALUES(?,?,?)",
          entries,
          "request-usage",
          projectId,
          (row) => [row.run_id, row.request_id, row.data],
        );
        insertRows(
          store,
          "INSERT INTO platform_receipts(project_id,operation,submission_id,payload_hash,response) VALUES(?,?,?,?,?)",
          entries,
          "receipts",
          projectId,
          (row) => [projectId, row.operation, row.submission_id, row.payload_hash, row.response],
        );
        insertRows(
          store,
          "INSERT INTO platform_submissions(project_id,submission_id,request_hash,response,plan_id,created_at) VALUES(?,?,?,?,?,?)",
          entries,
          "submissions",
          projectId,
          (row) => [projectId, row.submission_id, row.request_hash, row.response, row.plan_id ?? null, row.created_at],
        );
        insertRows(
          store,
          "INSERT INTO platform_plans(plan_id,project_id,submission_id,data,created_at) VALUES(?,?,?,?,?)",
          entries,
          "plans",
          projectId,
          (row) => [row.plan_id, projectId, row.submission_id, row.data, row.created_at],
        );
        insertRows(
          store,
          "INSERT INTO platform_pools(project_id,pool_revision,seed,fingerprint,algorithm,updated_at) VALUES(?,?,?,?,?,?)",
          entries,
          "pools",
          projectId,
          (row) => [projectId, row.pool_revision, row.seed, row.fingerprint, row.algorithm, row.updated_at],
        );
        insertRows(
          store,
          "INSERT INTO platform_events(project_id,revision,kind,data,created_at) VALUES(?,?,?,?,?)",
          entries,
          "events",
          projectId,
          (row) => [projectId, row.revision, row.kind, row.data, row.created_at],
        );
        insertRows(
          store,
          "INSERT INTO platform_diagnostics(project_id,run_id,event_id,data) VALUES(?,?,?,?)",
          entries,
          "diagnostics",
          projectId,
          (row) => [projectId, row.run_id, row.event_id, row.data],
        );
        insertRows(
          store,
          "INSERT INTO platform_reports(id,project_id,data) VALUES(?,?,?)",
          entries,
          "reports",
          projectId,
          (row) => [row.id, projectId, row.data],
        );
        // swarm 的消息与回合水位；旧备份不含这些分节时 insertRows 自然为空。
        insertRows(
          store,
          "INSERT INTO project_messages(project_id,seq,id,from_peer,to_peer,kind,body,refs,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          entries,
          "messages",
          projectId,
          (row) => [
            projectId,
            row.seq,
            row.id,
            row.from_peer ?? null,
            row.to_peer ?? null,
            row.kind,
            row.body,
            row.refs,
            row.created_at,
          ],
        );
        insertRows(
          store,
          "INSERT INTO project_peer_state(project_id,peer_id,wake,seen_revision,seen_message_seq,turn_start_revision,turn_start_message_seq,turns,last_turn_at,summary) VALUES(?,?,?,?,?,?,?,?,?,?)",
          entries,
          "peer-state",
          projectId,
          (row) => [
            projectId,
            row.peer_id,
            row.wake,
            row.seen_revision,
            row.seen_message_seq,
            row.turn_start_revision ?? 0,
            row.turn_start_message_seq ?? 0,
            row.turns ?? 0,
            row.last_turn_at ?? null,
            row.summary ?? null,
          ],
        );
        const insertTraffic = store.db.prepare(
          "INSERT INTO project_traffic(project_id,flow_id,created_at,updated_at,data,bytes) VALUES(?,?,?,?,?,?)",
        );
        forEachRow(entries, "traffic", (row) =>
          insertTraffic.run(projectId, row.flow_id, row.created_at, row.updated_at, row.data, row.bytes),
        );
        const status = entries.find((entry) => entry.name === "traffic-status.json");
        if (status)
          store.db
            .prepare("INSERT OR REPLACE INTO project_traffic_status VALUES(?,?)")
            .run(projectId, readFileSync(status.path, "utf8"));
        // Imported leases are stale by definition. Clearing them lets the project
        // resume immediately instead of waiting for an expired heartbeat. The old
        // workspace volume is not in the bundle, so the target instance's runtime
        // prefix becomes authoritative for the next Worker container.
        const current = store.get(projectId);
        current.project.volume_prefix = undefined;
        current.project.reason = null;
        current.project.decide_retry_at = undefined;
        current.project.model_retry_at = undefined;
        current.project.infra_retry_at = undefined;
        for (const step of current.steps) {
          if (!step.worker) continue;
          step.worker = null;
          step.last_heartbeat_at = null;
          step.retry_at = undefined;
        }
        for (const finding of current.findings) {
          if (!finding.review_worker) continue;
          finding.review_worker = null;
          finding.review_heartbeat = null;
          finding.retry_at = undefined;
        }
        // swarm 的租约同样属于源实例。把在岗执行者重新置为 ready，否则一个导出时
        // 处于 waiting、水位又已追平的执行者导入后再也不会被领取，项目静默停摆。
        // stuck 是操作员的明确闸门，原样保留。
        if ((current.project.mode ?? "classic") === "swarm" && current.project.status === "active")
          for (const peer of activePeers(current))
            if (store.swarm.state(projectId, peer.id).wake !== "stuck")
              store.swarm.setWake(projectId, peer.id, "ready");
        new GraphStorage(store.db).save(current);
        move(stagingPath, target);
        result = {
          project_id: projectId,
          title: current.project.title,
          status: current.project.status,
          created_at: current.project.created_at,
          counts: manifest.counts,
          warnings,
          updated_at: importedAt,
        };
      });
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      throw error;
    }
    try {
      store.search.rebuild(projectId, store.get(projectId), store.evidenceRoot);
    } catch (error) {
      warnings.push(`导入完成，但全文索引重建失败：${error instanceof Error ? error.message : "unknown"}`);
    }
    return result!;
  } finally {
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    rmSync(spool, { recursive: true, force: true });
  }
}
