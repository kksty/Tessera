import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { DomainError } from "./errors.js";
import { type ZipEntry } from "./archive.js";
import type { Store } from "./store.js";
import type { Graph, Run } from "../../protocol/src/index.js";

export const BUNDLE_SCHEMA = "tessera.project-bundle.v1";

/** Project bundles are maintenance artifacts: one entry per file, checksums in the manifest. */
export const BUNDLE_MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export const manifestSchema = z
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

export function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Export reads run on their own read-only connection inside one read
 * transaction, so a long ZIP build never holds a statement open on the write
 * connection and every row comes from one SQLite snapshot. In-memory stores
 * (tests) have no second connection and export through the primary one.
 */
export function openReadConnection(store: Store): DatabaseSync | undefined {
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
export function cleanStaleBundles(directory: string) {
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
export function cleanStaleStaging(store: Store) {
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

export class ChunkWriter {
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

export const README = `Tessera 项目完整备份
====================

这个 ZIP 是单个项目的完整快照，用于在另一个 Tessera 实例上原样恢复并继续工作。

包含内容
--------
- graph.json：探索图全部节点（事实、目标、任务、线索、Hint、发现、资产、证据元数据、审核、用量、书签）。
- events-*.ndjson：项目事件历史（时间线与黑板回放的数据来源）。
- diagnostics-*.ndjson：每个 Run 的模型/工具诊断日志；项目日志的主要部分。
- runs-*.ndjson、run-models-*.ndjson、request-usage-*.ndjson：Run 记录、模型固定信息、逐请求用量。
- receipts-*.ndjson、submissions-*.ndjson、plans-*.ndjson、pools-*.ndjson：幂等回执、提交与规划快照。
- messages-*.ndjson、peer-state-*.ndjson：swarm 执行者之间的消息与回合投递水位（旧项目为空）。
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

export interface SpoolEntry {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export const graphCollections = [
  "facts",
  "goals",
  "steps",
  "findings",
  "assets",
  "evidence",
  "reviews",
  "usage",
] as const;

export function bundleGraph(raw: unknown): Graph {
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
  // swarm 身份的持久部分随 graph.json 导出；旧备份不含这两段，缺失视为空。
  for (const key of ["peers", "rounds"] as const)
    if (graph[key] !== undefined && !Array.isArray(graph[key]))
      throw new DomainError(422, `备份的 graph.json 的 ${key} 必须是数组`);
  for (const peer of graph.peers ?? [])
    if (
      !peer ||
      typeof peer.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(peer.id) ||
      (peer.status !== "active" && peer.status !== "retired")
    )
      throw new DomainError(422, "备份包含非法的执行者记录");
  for (const round of graph.rounds ?? [])
    if (!round || typeof round.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(round.id))
      throw new DomainError(422, "备份包含非法的共识轮次记录");
  for (const evidence of graph.evidence) {
    if (!evidence || typeof evidence.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(evidence.id))
      throw new DomainError(422, "备份包含非法的证据 ID");
    if (!Number.isInteger(evidence.size) || evidence.size < 0 || !/^[a-f0-9]{64}$/.test(evidence.sha256))
      throw new DomainError(422, `证据 ${evidence.id} 的元数据无效`);
  }
  return graph;
}

export function chunkFiles(entries: SpoolEntry[], prefix: string) {
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.ndjson$`);
  return entries.filter((entry) => pattern.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
}

/** Stream one category a chunk at a time so a large log never has to be fully materialized. */
export function forEachRow(entries: SpoolEntry[], prefix: string, handler: (row: Record<string, any>) => void) {
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

export function insertRows(
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
