import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Graph } from "../../protocol/src/index.js";
import { activeGraph, deletedNodeRefs } from "../../protocol/src/node-lifecycle.js";
import { coldNodes, firstSentence } from "./projection.js";

/** Evidence bodies are indexed up to this many characters; binaries keep metadata only. */
export const EVIDENCE_INDEX_LIMIT = 64_000;
export const SEARCH_SCHEMA_VERSION = 2;

const textFields: Record<string, (record: Record<string, any>) => string> = {
  facts: (r) =>
    [r.description, r.conclusion, ...(Array.isArray(r.objects) ? r.objects : [])].filter(Boolean).join("\n"),
  steps: (r) => [r.description, r.summary, r.close_reason, r.discard_reason, r.property].filter(Boolean).join("\n"),
  leads: (r) => [r.surface, r.parameter, r.why, r.suggested_property, r.waiver_reason].filter(Boolean).join("\n"),
  findings: (r) =>
    [r.title, r.description, r.evidence, r.impact, r.remediation, r.severity_reason].filter(Boolean).join("\n"),
  goals: (r) => r.description ?? "",
  hints: (r) => r.content ?? "",
  assets: (r) => r.hostname ?? "",
  evidence: (r) => [r.title, r.source_path].filter(Boolean).join("\n"),
  reviews: (r) => [r.reason, r.verification].filter(Boolean).join("\n"),
  bookmarks: (r) => [r.reason, r.revisit_when].filter(Boolean).join("\n"),
};

export const indexedKinds = Object.keys(textFields) as (keyof typeof textFields)[];
/** One field mapping for both FTS and in-memory keyword scans; they must agree. */
export const recordText = (kind: string, record: Record<string, any>) => textFields[kind]?.(record) ?? "";

/**
 * FTS5 is a derived index: the graph JSON stays the only truth. Rows are updated
 * inside the same transaction as the graph write; a version mismatch rebuilds in full.
 */
export class MemorySearch {
  constructor(private readonly db: DatabaseSync) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        project_id UNINDEXED, kind UNINDEXED, record_id UNINDEXED, text, tokenize='trigram');`);
    } catch (error) {
      throw new Error(`Full-text search is unavailable in this SQLite build: ${(error as Error).message}`);
    }
  }
  version(): number {
    const row = this.db.prepare("SELECT value FROM platform_meta WHERE key='search_version'").get();
    return Number(row?.value || 0);
  }
  markVersion() {
    this.db
      .prepare(
        "INSERT INTO platform_meta(key,value) VALUES('search_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(SEARCH_SCHEMA_VERSION));
  }
  /** Rebuild every row of one project, including evidence bodies read from disk. */
  rebuild(projectId: string, graph: Graph, evidenceRoot?: string, readBody = true) {
    graph = activeGraph(graph);
    this.db.prepare("DELETE FROM memory_fts WHERE project_id=?").run(projectId);
    const insert = this.db.prepare("INSERT INTO memory_fts(project_id,kind,record_id,text) VALUES(?,?,?,?)");
    for (const kind of indexedKinds) {
      for (const record of ((graph as unknown as Record<string, unknown[]>)[kind] ?? []) as unknown as Record<
        string,
        any
      >[]) {
        let text = textFields[kind](record);
        if (kind === "evidence" && record.indexed !== false && evidenceRoot) {
          const body = readEvidenceText(evidenceRoot, projectId, record.id, this.db);
          if (body) text += `\n${body}`;
        }
        insert.run(projectId, kind, String(record.id), text);
      }
    }
  }
  remove(projectId: string) {
    this.db.prepare("DELETE FROM memory_fts WHERE project_id=?").run(projectId);
  }
  /** Update only the records a graph write actually changed. */
  sync(projectId: string, changed: Record<string, unknown[]>, evidenceRoot?: string, graph?: Graph) {
    if (graph && deletedNodeRefs(graph).length) {
      this.rebuild(projectId, graph, evidenceRoot);
      return;
    }
    const remove = this.db.prepare("DELETE FROM memory_fts WHERE project_id=? AND kind=? AND record_id=?");
    const insert = this.db.prepare("INSERT INTO memory_fts(project_id,kind,record_id,text) VALUES(?,?,?,?)");
    for (const [kind, records] of Object.entries(changed)) {
      const extract = textFields[kind];
      if (!extract) continue;
      for (const record of records as Record<string, any>[]) {
        remove.run(projectId, kind, String(record.id));
        let text = extract(record);
        if (kind === "evidence" && record.indexed !== false && evidenceRoot) {
          const body = readEvidenceText(evidenceRoot, projectId, record.id, this.db);
          if (body) text += `\n${body}`;
        }
        insert.run(projectId, kind, String(record.id), text);
      }
    }
  }
  /** A short keyword uses LIKE (trigram needs three characters); both search the same indexed text. */
  search(projectId: string, keyword: string, kind?: string): string[] {
    const term = keyword.trim();
    if (!term) return [];
    const clause = kind ? "project_id=? AND kind=? AND" : "project_id=? AND";
    const params: (string | number)[] = kind ? [projectId, kind] : [projectId];
    if (term.length >= 3) {
      const rows = this.db
        .prepare(`SELECT DISTINCT record_id FROM memory_fts WHERE ${clause} text MATCH ?`)
        .all(...params, `"${term.replace(/"/g, '""')}"`);
      return rows.map((row) => String(row.record_id));
    }
    const rows = this.db
      .prepare(`SELECT DISTINCT record_id FROM memory_fts WHERE ${clause} text LIKE ? ESCAPE '\\'`)
      .all(...params, `%${term.replace(/[\\%_]/g, (value) => `\\${value}`)}%`);
    return rows.map((row) => String(row.record_id));
  }
  /** Index fingerprint for a project; mismatch triggers a rebuild at startup. */
  static fingerprint(graph: Graph): string {
    return createHash("sha256")
      .update(JSON.stringify([graph.project.id, graph.revision, graph.evidence.length]))
      .digest("hex");
  }
}

function readEvidenceText(root: string, projectId: string, evidenceId: string, db: DatabaseSync): string {
  try {
    let bytes: Buffer;
    try {
      bytes = readFileSync(`${root}/${projectId}/${evidenceId}`);
    } catch {
      const row = db
        .prepare("SELECT data FROM platform_evidence_archive WHERE project_id=? AND id=?")
        .get(projectId, evidenceId);
      if (!row) return "";
      bytes = gunzipSync(row.data as Uint8Array);
    }
    if (bytes.includes(0)) return "";
    return bytes.subarray(0, EVIDENCE_INDEX_LIMIT).toString("utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Cold pool: deterministic shuffle over cold nodes, persisted seed per pool revision
// ---------------------------------------------------------------------------

export interface PeekQuery {
  cursor?: string;
  limit?: number;
  kind?: string;
}
export interface PeekItem {
  kind: string;
  id: string;
  status: string;
  conclusion?: string;
  summary: string;
}
export interface PeekPage {
  snapshot_revision: number;
  mode: "peek";
  total: number;
  seen: number;
  seed: string;
  pool_revision: number;
  algorithm: string;
  items: PeekItem[];
  next_cursor: string | null;
  disabled?: boolean;
}

const ALGORITHM = "mulberry32-fisher-yates-v1";
export { ALGORITHM as PEEK_ALGORITHM };

/** Stable 32-bit PRNG: the same seed and pool always produce the same order. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let state = 0;
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

interface PoolRow {
  kind: string;
  record: Record<string, any>;
}

/** The cold pool is Facts/Findings over the hot budget; Steps and Evidence are not cold. */
export function coldPool(graph: Graph): PoolRow[] {
  return coldNodes(graph).map(({ kind, record }) => ({ kind, record }));
}

export function peekItem({ kind, record }: PoolRow): PeekItem {
  const body = String(record.description ?? record.title ?? record.content ?? record.hostname ?? "");
  const conclusion = typeof record.conclusion === "string" ? record.conclusion : undefined;
  const status = String(record.approval ?? record.review_status ?? record.status ?? "observation");
  return {
    kind,
    id: String(record.id),
    status,
    ...(conclusion ? { conclusion } : {}),
    summary: firstSentence(body, 600),
  };
}

/** Cursor is self-describing so a page is reproducible without server session state. */
export interface PeekCursor {
  v: 1;
  pool_revision: number;
  seed: string;
  offset: number;
  seen: string[];
}
