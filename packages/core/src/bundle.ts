import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { DiagnosticRecords, diagnosticBuild } from "./diagnostics.js";
import { DomainError, fail } from "./errors.js";
import { GraphStorage } from "./graph-storage.js";
import { readZip, safeArchiveName, writeZip, type ZipEntry } from "./archive.js";
import type { Store } from "./store.js";
import type { Graph, Run } from "../../protocol/src/index.js";

export const BUNDLE_SCHEMA = "tessera.project-bundle.v1";
/** Project bundles are maintenance artifacts: one entry per file, checksums in the manifest. */
export const BUNDLE_MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const manifestSchema = z
  .object({
    schema: z.literal(BUNDLE_SCHEMA),
    format_version: z.literal(1),
    created_at: z.string().min(1),
    server_build: z.unknown(),
    project: z
      .object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_-]+$/),
        title: z.string().min(1).max(4096),
        status: z.enum(["active", "stopped", "completed"]),
        created_at: z.string().optional(),
      })
      .strict(),
    counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    warnings: z.array(z.string().max(2000)).default([]),
    missing_evidence: z.array(z.string().max(128)).default([]),
    contents: z.array(z.string().max(200)).default([]),
    note: z.string().max(4000).optional(),
  })
  .strict();

export type BundleManifest = z.infer<typeof manifestSchema>;

export interface BundleImportResult {
  project_id: string;
  title: string;
  status: Graph["project"]["status"];
  created_at: string;
  counts: Record<string, number>;
  warnings: string[];
  updated_at: string;
}

/** Bundle staging lives next to the evidence root so imports can rename instead of copy. */
export function bundleTempRoot(store: Store) {
  return process.env.TESSERA_BUNDLE_TMP || join(dirname(store.evidenceRoot), "bundle-tmp");
}

function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Export reads run on their own read-only connection inside one read
 * transaction, so a long ZIP build never holds a statement open on the write
 * connection and every row comes from one SQLite snapshot. In-memory stores
 * (tests) have no second connection and export through the primary one.
 */
function openReadConnection(store: Store): DatabaseSync | undefined {
  const location = store.db.location();
  if (!location || location === ":memory:") return undefined;
  const reader = new DatabaseSync(location, { readOnly: true });
  try {
    reader.function("tessera_inflate", { deterministic: true }, (value) =>
      gunzipSync(value as Uint8Array).toString("utf8"),
    );
    reader.exec("PRAGMA busy_timeout=5000");
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
}

/** Remove leftovers from crashed exports/imports; recent files belong to running requests. */
function cleanStaleBundles(directory: string) {
  const cutoff = Date.now() - 86400000;
  try {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/** Interrupted imports can leave a hidden staging directory next to evidence. */
function cleanStaleStaging(store: Store) {
  const cutoff = Date.now() - 86400000;
  try {
    for (const name of readdirSync(store.evidenceRoot)) {
      if (!name.startsWith(".import-")) continue;
      const path = join(store.evidenceRoot, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

class ChunkWriter {
  private lines: string[] = [];
  private size = 0;
  private index = 0;
  constructor(
    private readonly prefix: string,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}
  push(row: unknown): ZipEntry | undefined {
    const line = JSON.stringify(row);
    this.lines.push(line);
    this.size += line.length + 1;
    return this.size >= this.maxBytes ? this.flush() : undefined;
  }
  flush(): ZipEntry | undefined {
    if (!this.lines.length) return undefined;
    const name = `${this.prefix}-${String(++this.index).padStart(4, "0")}.ndjson`;
    const bytes = Buffer.from(this.lines.join("\n") + "\n");
    this.lines = [];
    this.size = 0;
    return { name, bytes };
  }
}

const README = `Tessera 项目完整备份
====================

这个 ZIP 是单个项目的完整快照，用于在另一个 Tessera 实例上原样恢复并继续工作。

包含内容
--------
- graph.json：探索图全部节点（事实、目标、任务、线索、Hint、发现、资产、证据元数据、审核、用量、书签）。
- events-*.ndjson：项目事件历史（时间线与黑板回放的数据来源）。
- diagnostics-*.ndjson：每个 Run 的模型/工具诊断日志；项目日志的主要部分。
- runs-*.ndjson、run-models-*.ndjson、request-usage-*.ndjson：Run 记录、模型固定信息、逐请求用量。
- receipts-*.ndjson、submissions-*.ndjson、plans-*.ndjson、pools-*.ndjson：幂等回执、提交与规划快照。
- reports-*.ndjson：已生成的报告快照（含原始材料）。
- traffic-*.ndjson、traffic-status.json、traffic-bodies/*：HTTP/HTTPS 流量记录与正文原件。
- evidence/*：证据原件（与 graph.json 中的 SHA-256 一致）。
- manifest.json：清单，列出条目校验和、计数、缺失原件警告与导出时间。

不包含
------
- Docker 项目工作区卷 /workspace（脚本、会话目录等运行现场文件）。恢复后新的 Run 会使用新的工作区。
- 模型 API Key、登录凭据等平台级密钥。
- 本机运行配置（模型、并发、网络）。导入后沿用目标实例的设置。

导入
----
在「项目」页使用「导入项目」，选择本 ZIP。导入保留原项目 ID；同一 ID 已存在时拒绝导入。
导入会把导出时仍在运行的 Run 标记为中断，并清理租约，使项目可以继续领取新任务。
`;

/**
 * Export one project as a self-contained ZIP. Reads run on a dedicated read-only
 * connection inside one read transaction, so every row comes from the same SQLite
 * snapshot while the write connection keeps serving the control plane.
 */
export async function exportProjectBundle(store: Store, projectId: string, file: string): Promise<BundleManifest> {
  cleanStaleBundles(ensureDirectory(bundleTempRoot(store)));
  // Validate through the store first (format/lifecycle checks and deletion lock).
  const current = store.get(projectId);
  if (current.project.deletion) fail(409, "项目正在删除，不能导出");
  const reader = openReadConnection(store);
  const db = reader ?? store.db;
  // The diagnostics tables are created lazily by the recorder; the exporter must
  // not fail on a bare instance that never served a Run. Create them before the
  // reader's snapshot begins so the history views are part of it.
  new DiagnosticRecords(store.db);
  try {
    if (reader) reader.exec("BEGIN");
    const header =
      db.prepare("SELECT data FROM platform_projects WHERE id=?").get(projectId) ?? fail(404, "Project not found");
    const graph = reader ? new GraphStorage(db).load(projectId, String(header.data)) : current;
    const diagnosticThrough = Number(
      db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM platform_diagnostic_history WHERE project_id=?").get(projectId)
        ?.n || 0,
    );
    const eventThrough = Number(
      db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM platform_event_history WHERE project_id=?").get(projectId)?.n ||
        0,
    );
    const count = (sql: string, ...params: (string | number)[]) => Number(db.prepare(sql).get(...params)?.n || 0);
    const counts = {
      facts: graph.facts.length,
      goals: graph.goals.length,
      steps: graph.steps.length,
      leads: graph.leads?.length ?? 0,
      hints: graph.hints?.length ?? 0,
      findings: graph.findings.length,
      assets: graph.assets.length,
      evidence: graph.evidence.length,
      reviews: graph.reviews.length,
      usage: graph.usage.length,
      events: count(
        "SELECT COUNT(*) AS n FROM platform_event_history WHERE project_id=? AND seq<=?",
        projectId,
        eventThrough,
      ),
      runs: count("SELECT COUNT(*) AS n FROM platform_runs WHERE project_id=?", projectId),
      diagnostics: count(
        "SELECT COUNT(*) AS n FROM platform_diagnostic_history WHERE project_id=? AND seq<=?",
        projectId,
        diagnosticThrough,
      ),
      traffic: count("SELECT COUNT(*) AS n FROM project_traffic WHERE project_id=?", projectId),
      reports: count("SELECT COUNT(*) AS n FROM platform_reports WHERE project_id=?", projectId),
    };
    const warnings: string[] = [];
    const missingEvidence: string[] = [];
    const manifest: BundleManifest = {
      schema: BUNDLE_SCHEMA,
      format_version: 1,
      created_at: new Date().toISOString(),
      server_build: diagnosticBuild,
      project: {
        id: graph.project.id,
        title: graph.project.title,
        status: graph.project.status,
        ...(graph.project.created_at ? { created_at: graph.project.created_at } : {}),
      },
      counts,
      files: {},
      warnings,
      missing_evidence: missingEvidence,
      contents: [
        "graph.json",
        "events-*.ndjson",
        "diagnostics-*.ndjson",
        "runs-*.ndjson",
        "reports-*.ndjson",
        "traffic-*.ndjson",
        "evidence/*",
        "traffic-bodies/*",
      ],
      note: "Graph snapshotted at export start; Runs, diagnostics and events are included up to that point. Loose evidence files are stored uncompressed metadata-compatible originals; ZIP compression applies to the archive only. In-flight Runs are marked interrupted on import.",
    };
    const emit = (entry: ZipEntry) => {
      manifest.files[entry.name] = sha256(entry.bytes);
      return entry;
    };
    function* category(prefix: string, rows: Iterable<Record<string, unknown>>): Generator<ZipEntry> {
      const chunk = new ChunkWriter(prefix);
      for (const row of rows) {
        const entry = chunk.push(row);
        if (entry) yield emit(entry);
      }
      const tail = chunk.flush();
      if (tail) yield emit(tail);
    }
    function* trafficRows(): Generator<ZipEntry> {
      const chunk = new ChunkWriter("traffic");
      const bodies = new Set<string>();
      for (const row of db
        .prepare("SELECT flow_id,created_at,updated_at,data,bytes FROM project_traffic WHERE project_id=? ORDER BY seq")
        .iterate(projectId) as IterableIterator<any>) {
        try {
          const record = JSON.parse(String(row.data));
          for (const message of [record.request, record.response])
            if (message?.body_id) bodies.add(String(message.body_id));
        } catch {}
        const entry = chunk.push({ ...row });
        if (entry) yield emit(entry);
      }
      const tail = chunk.flush();
      if (tail) yield emit(tail);
      for (const bodyId of bodies) {
        try {
          const path = store.traffic.bodyPath(projectId, bodyId);
          if (!existsSync(path)) {
            warnings.push(`流量正文缺失：${bodyId}`);
            continue;
          }
          yield emit({ name: `traffic-bodies/${bodyId}`, bytes: readFileSync(path) });
        } catch (error) {
          warnings.push(`流量正文不可读：${bodyId}（${error instanceof Error ? error.message : "unknown"}）`);
        }
      }
    }
    function* allEntries(): Generator<ZipEntry> {
      yield emit({ name: "README.txt", bytes: Buffer.from(README) });
      yield emit({ name: "graph.json", bytes: Buffer.from(JSON.stringify(graph)) });
      yield* category(
        "events",
        db
          .prepare(
            "SELECT revision,kind,data,created_at FROM platform_event_history WHERE project_id=? AND seq<=? ORDER BY seq",
          )
          .iterate(projectId, eventThrough) as IterableIterator<any>,
      );
      yield* category(
        "diagnostics",
        db
          .prepare(
            "SELECT run_id,event_id,data FROM platform_diagnostic_history WHERE project_id=? AND seq<=? ORDER BY seq",
          )
          .iterate(projectId, diagnosticThrough) as IterableIterator<any>,
      );
      yield* category(
        "runs",
        db
          .prepare("SELECT id,worker,kind,node_id,status,data FROM platform_runs WHERE project_id=? ORDER BY rowid")
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "run-models",
        db
          .prepare(
            "SELECT m.run_id,m.data FROM platform_run_models m JOIN platform_runs r ON r.id=m.run_id WHERE r.project_id=? ORDER BY m.run_id",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "request-usage",
        db
          .prepare(
            "SELECT u.run_id,u.request_id,u.data FROM platform_request_usage u JOIN platform_runs r ON r.id=u.run_id WHERE r.project_id=? ORDER BY u.run_id,u.request_id",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "receipts",
        db
          .prepare(
            "SELECT operation,submission_id,payload_hash,response FROM platform_receipts WHERE project_id=? ORDER BY operation,submission_id",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "submissions",
        db
          .prepare(
            "SELECT submission_id,request_hash,response,plan_id,created_at FROM platform_submissions WHERE project_id=? ORDER BY created_at,submission_id",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "plans",
        db
          .prepare(
            "SELECT plan_id,submission_id,data,created_at FROM platform_plans WHERE project_id=? ORDER BY created_at",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "pools",
        db
          .prepare("SELECT pool_revision,seed,fingerprint,algorithm,updated_at FROM platform_pools WHERE project_id=?")
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "reports",
        db
          .prepare("SELECT id,data FROM platform_reports WHERE project_id=? ORDER BY rowid")
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* trafficRows();
      const status = db.prepare("SELECT data FROM project_traffic_status WHERE project_id=?").get(projectId);
      if (status) yield emit({ name: "traffic-status.json", bytes: Buffer.from(String(status.data)) });
      for (const evidence of graph.evidence) {
        try {
          const { bytes } = store.evidenceContent(projectId, evidence.id);
          if (bytes.length !== evidence.size || sha256(bytes) !== evidence.sha256)
            throw new Error("原件大小或 SHA-256 与图记录不一致");
          yield emit({ name: `evidence/${evidence.id}`, bytes });
        } catch (error) {
          missingEvidence.push(evidence.id);
          warnings.push(
            `证据原件缺失：${evidence.id}（${error instanceof Error ? error.message : "unknown"}）；备份仍包含其元数据`,
          );
        }
      }
      // Manifest is written last: its `files` map covers every entry, and readers
      // can verify checksums after extracting, before touching the database.
      yield { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest, null, 2)) };
    }
    await writeZip(file, allEntries());
    return manifest;
  } finally {
    if (reader) {
      try {
        reader.exec("ROLLBACK");
      } catch {}
      reader.close();
    }
  }
}

interface SpoolEntry {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

const graphCollections = ["facts", "goals", "steps", "findings", "assets", "evidence", "reviews", "usage"] as const;

function bundleGraph(raw: unknown): Graph {
  const graph = raw as Graph;
  if (!graph || typeof graph !== "object") throw new DomainError(422, "备份缺少有效的 graph.json");
  if (graph.format_version !== 1)
    throw new DomainError(409, "备份由不兼容的 Tessera 版本创建（format_version 不一致），无法导入");
  for (const version of [graph.node_lifecycle_version, graph.finding_classification_version])
    if (version !== undefined && version !== 1) throw new DomainError(409, "备份使用不支持的数据版本");
  if (!graph.project || typeof graph.project.id !== "string" || typeof graph.project.title !== "string")
    throw new DomainError(422, "备份缺少项目头");
  // Project and evidence ids become directory names under the evidence root.
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(graph.project.id)) throw new DomainError(422, "备份的项目 ID 含非法字符");
  if (!graph.project.title.trim() || graph.project.title.length > 4096)
    throw new DomainError(422, "备份的项目名称无效");
  if (!["active", "stopped", "completed"].includes(graph.project.status))
    throw new DomainError(422, "备份的项目状态无效");
  if (graph.project.deletion) throw new DomainError(409, "备份包含正在删除的项目");
  for (const key of graphCollections)
    if (!Array.isArray(graph[key])) throw new DomainError(422, `备份的 graph.json 缺少 ${key} 集合`);
  for (const evidence of graph.evidence) {
    if (!evidence || typeof evidence.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(evidence.id))
      throw new DomainError(422, "备份包含非法的证据 ID");
    if (!Number.isInteger(evidence.size) || evidence.size < 0 || !/^[a-f0-9]{64}$/.test(evidence.sha256))
      throw new DomainError(422, `证据 ${evidence.id} 的元数据无效`);
  }
  return graph;
}

function chunkFiles(entries: SpoolEntry[], prefix: string) {
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.ndjson$`);
  return entries.filter((entry) => pattern.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
}

/** Stream one category a chunk at a time so a large log never has to be fully materialized. */
function forEachRow(entries: SpoolEntry[], prefix: string, handler: (row: Record<string, any>) => void) {
  for (const file of chunkFiles(entries, prefix)) {
    if (file.size > 64 * 1024 * 1024) throw new DomainError(413, `${file.name} 过大`);
    for (const line of readFileSync(file.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        throw new DomainError(422, `备份条目 ${file.name} 含无效 JSON`);
      }
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new DomainError(422, `备份条目 ${file.name} 含非对象记录`);
      handler(row as Record<string, any>);
    }
  }
}

function insertRows(
  store: Store,
  sql: string,
  entries: SpoolEntry[],
  prefix: string,
  projectId: string,
  map: (row: any) => unknown[],
) {
  const statement = store.db.prepare(sql);
  let count = 0;
  forEachRow(entries, prefix, (row) => {
    if (row.project_id !== undefined && row.project_id !== projectId)
      throw new DomainError(422, "备份内容属于其他项目");
    statement.run(...(map(row) as any[]));
    count++;
  });
  return count;
}

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
