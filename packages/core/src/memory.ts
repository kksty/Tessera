import { createHash } from "node:crypto";
import type { Graph, Job, NodeDeletion } from "../../protocol/src/index.js";
import { resolveGraphRelations, walkRelations, type FactProvenance } from "../../protocol/src/graph-relations.js";
import { activeGraph, deletedNodeRefs } from "../../protocol/src/node-lifecycle.js";
import {
  coldView,
  executeEntry,
  firstSentence,
  projectEntry,
  reviewEntry,
  stepState,
  type EntryChanges,
  type StepLimits,
} from "./projection.js";
import { recordText } from "./search.js";

export const memoryKinds = [
  "facts",
  "steps",
  "leads",
  "findings",
  "goals",
  "hints",
  "assets",
  "evidence",
  "reviews",
  "bookmarks",
] as const;
export type MemoryKind = (typeof memoryKinds)[number];
export const MEMORY_DEFAULT_LIMIT = 50;
export const MEMORY_MAX_LIMIT = 200;
export type MemoryMode = "peek" | "query";
export interface MemoryQuery {
  kind?: MemoryKind;
  keyword?: string;
  asset_id?: string;
  status?: string;
  related_to?: string;
  relation?: "sources" | "outputs";
  /** 1..3; only meaningful with related_to. */
  depth?: number;
  cursor?: string;
  limit?: number;
  mode?: MemoryMode;
  /** Optional server-side FTS hit list (kind-independent id set); absent means text scan. */
  hits?: Set<string>;
  /** Explicit history opt-in; never used by ordinary work queries. */
  history?: boolean;
}

function records(graph: Graph) {
  return memoryKinds.flatMap((kind) =>
    (graph[kind] ?? []).map((record) => ({
      kind,
      record: record as unknown as Record<string, unknown> & { id: string },
    })),
  );
}

export function state(kind: MemoryKind, r: Record<string, unknown>) {
  if (r.deleted || r.deleted_at) return "deleted";
  if (kind === "findings" && r.merged_into) return "merged";
  if (kind === "findings" && r.withdrawn_at) return "withdrawn";
  if (kind === "steps") return stepState(r as unknown as Graph["steps"][number]);
  if (kind === "hints" || kind === "bookmarks") return r.withdrawn_at ? "withdrawn" : "active";
  return String(r.review_status ?? r.approval ?? r.state ?? r.status ?? "observed");
}

const createdAt = (r: Record<string, unknown>) => (typeof r.created_at === "string" ? r.created_at : "");

/** Deterministic ordering: newest first, id as the tiebreaker. */
export function compareRecords(a: { record: Record<string, unknown> }, b: { record: Record<string, unknown> }) {
  return (
    createdAt(b.record).localeCompare(createdAt(a.record)) || String(b.record.id).localeCompare(String(a.record.id))
  );
}

/** Queries are pinned to the supplied snapshot; a cursor cannot silently cross revisions or filters. */
export function queryMemory(graph: Graph, query: MemoryQuery = {}) {
  if (!query.history) graph = activeGraph(graph);
  const { cursor, limit = MEMORY_DEFAULT_LIMIT, mode = "query", depth = 1, ...filter } = query;
  if (!Number.isInteger(limit) || limit < 0 || limit > MEMORY_MAX_LIMIT)
    throw new Error(`Memory limit must be between 0 and ${MEMORY_MAX_LIMIT}`);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3)
    throw new Error("Memory relation depth must be between 1 and 3");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        graph.project.id,
        graph.revision,
        filter.kind,
        filter.keyword,
        filter.asset_id,
        filter.status,
        filter.related_to,
        filter.relation,
        depth,
        mode,
        filter.history,
      ]),
    )
    .digest("hex");
  let offset = 0;
  if (cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed.fingerprint !== fingerprint || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
      throw new Error("Memory cursor does not match this snapshot/query; restart without cursor");
    offset = parsed.offset;
  }
  const all = records(graph);
  if (filter.related_to && !filter.history)
    for (const ref of graph.deleted_nodes ?? [])
      all.push({ kind: ref.kind, record: { ...ref, description: "来源节点已删除" } });
  const cold = filter.status === "cold" || filter.status === "hot" ? coldView(graph).cold : undefined;
  const index = resolveGraphRelations(graph);
  const byId = new Map(all.map((item) => [item.record.id, item]));
  const direction = filter.relation ?? "sources";
  const related = walkRelations(
    index,
    filter.related_to && byId.has(filter.related_to) ? [filter.related_to] : [],
    direction,
    depth,
  );
  const rows = all
    .filter(({ kind, record: r }) => {
      if (filter.kind && kind !== filter.kind) return false;
      if (
        filter.keyword &&
        !filter.hits &&
        !recordText(kind, r).toLocaleLowerCase().includes(filter.keyword.toLocaleLowerCase())
      )
        return false;
      if (filter.keyword && filter.hits && !filter.hits.has(r.id)) return false;
      if (filter.asset_id && r.asset_id !== filter.asset_id && !(kind === "assets" && r.id === filter.asset_id))
        return false;
      if (filter.status) {
        const current = state(kind, r);
        if (filter.status === "cold" || filter.status === "hot") {
          // Only Facts/Findings have a hot/cold state; closed Steps and Evidence are
          // history, neither hot nor cold, and stay queryable by kind.
          if (kind !== "facts" && kind !== "findings") return false;
          const isCold = cold!.has(String(r.id));
          if (filter.status === "cold" ? !isCold : isCold) return false;
        } else if (filter.status === "open" || filter.status === "closed") {
          const closed = !!(r.concluded_at || r.withdrawn_at || r.discarded);
          if (filter.status === "closed" ? !closed : closed) return false;
        } else if (current !== filter.status) return false;
      }
      if (filter.related_to && !related.depths.has(r.id)) return false;
      return true;
    })
    .sort(compareRecords);
  const items: {
    kind: MemoryKind;
    id: string;
    status: string;
    conclusion?: string | null;
    preview: string;
    preview_truncated: boolean;
    node_id?: string;
    version?: number;
    revisit_when?: string;
    provenance?: FactProvenance;
    relation_depth?: number;
  }[] = [];
  const result = (next: number) => ({
    snapshot_revision: graph.revision,
    mode,
    total: rows.length,
    items,
    ...(filter.related_to
      ? {
          relations: related.relations.filter((edge) =>
            items.some((item) => item.id === (direction === "sources" ? edge.source : edge.target)),
          ),
          ...(index.facts.has(filter.related_to) ? { provenance: index.facts.get(filter.related_to) } : {}),
        }
      : {}),
    remaining: Math.max(0, rows.length - next),
    next_cursor:
      next < rows.length ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString("base64url") : null,
  });
  for (const { kind, record } of rows.slice(offset, offset + limit)) {
    // Leads have no description/content field: surface + why is their text.
    const text = String(
      kind === "leads"
        ? [record.surface, record.why, record.waiver_reason].filter(Boolean).join(" — ")
        : (record.description ??
            record.content ??
            record.title ??
            record.reason ??
            record.summary ??
            record.hostname ??
            ""),
    );
    const summary = firstSentence(text, 300);
    items.push({
      kind,
      id: record.id,
      status: state(kind, record),
      ...(typeof record.conclusion === "string" ? { conclusion: record.conclusion } : {}),
      preview: summary,
      preview_truncated: summary.length < text.length,
      ...(kind === "facts" ? { provenance: index.facts.get(record.id) } : {}),
      ...(kind === "findings" ? { version: Number(record.version) } : {}),
      ...(record.deleted_at ? { deleted: true, history_ref: record.history_ref } : {}),
      ...(filter.related_to ? { relation_depth: related.depths.get(record.id) } : {}),
      ...(kind === "bookmarks"
        ? {
            node_id: String(record.node_id),
            version: Number(record.version),
            revisit_when: String(record.revisit_when).slice(0, 120),
          }
        : {}),
    });
  }
  return result(offset + items.length);
}

export interface MemoryRecordPage {
  snapshot_revision: number;
  error?: string;
  id?: string;
  kind?: MemoryKind;
  record_hash?: string;
  format?: "json";
  offset?: number;
  total_chars?: number;
  content?: string;
  next_offset?: number | null;
  provenance?: FactProvenance;
  deleted?: boolean;
  history_ref?: string;
  deletion?: NodeDeletion;
}

/** Current records never carry revision snapshots or deletion audit metadata. */
function currentRecord(record: Record<string, unknown> & { id: string }) {
  if (record.edits === undefined && record.restored === undefined) return record;
  const { edits: _edits, restored: _restored, ...current } = record;
  return current;
}

/** Raw record JSON is explicitly paged, including large arrays and descriptions. */
export function readMemoryRecord(
  graph: Graph,
  id: string,
  offset = 0,
  limit = 4000,
  expectedHash?: string,
  history = false,
): MemoryRecordPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000)
    throw new Error("Invalid record offset/limit");
  const ref = deletedNodeRefs(graph).find((ref) => ref.id === id);
  if (!history && ref)
    return {
      id,
      kind: ref.kind,
      deleted: true,
      history_ref: ref.history_ref,
      snapshot_revision: graph.revision,
      content: JSON.stringify({
        id,
        status: "deleted",
        message: "节点已删除；原文与旧版本仅供操作员，任务内不可读取",
        history_ref: ref.history_ref,
      }),
      next_offset: null,
    };
  if (!history) graph = activeGraph(graph);
  const found = records(graph).find((item) => item.record.id === id);
  if (!found) return { error: "Record not found", snapshot_revision: graph.revision };
  const text = JSON.stringify(history ? found.record : currentRecord(found.record));
  const record_hash = createHash("sha256").update(text).digest("hex");
  if (expectedHash && expectedHash !== record_hash)
    return { error: "Record changed; restart at offset 0", snapshot_revision: graph.revision, record_hash };
  return {
    id,
    kind: found.kind,
    snapshot_revision: graph.revision,
    record_hash,
    format: "json",
    offset,
    ...(history && found.record.deleted ? { deletion: found.record.deleted as unknown as NodeDeletion } : {}),
    ...(found.kind === "facts" ? { provenance: resolveGraphRelations(graph).facts.get(id) } : {}),
    total_chars: text.length,
    content: text.slice(offset, offset + limit),
    next_offset: offset + limit < text.length ? offset + limit : null,
  };
}

/**
 * Per-job projection: Decide gets every unclosed node; Execute gets its Step and
 * direct support; Review gets the Finding, its source Facts and evidence list.
 */
export function memoryEntry(
  graph: Graph,
  job: Job,
  changes?: EntryChanges,
  limits?: StepLimits,
): ReturnType<typeof projectEntry> {
  // Execute/Review views are narrower; the shape is a projection, not a storage contract.
  if (job.kind === "review") return reviewEntry(graph, job) as unknown as ReturnType<typeof projectEntry>;
  if (job.kind === "execute") return executeEntry(graph, job) as unknown as ReturnType<typeof projectEntry>;
  return projectEntry(graph, job.step_id ?? job.finding_id ?? "goal", changes, limits);
}
