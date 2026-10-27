import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Graph, Event } from "../../protocol/src/index.js";
import { ChangesQueryError, queryChanges, type ChangesQuery } from "./memory-changes.js";
import {
  coldPool,
  MemorySearch,
  peekItem,
  seededShuffle,
  PEEK_ALGORITHM as ALGORITHM,
  type PeekCursor,
  type PeekPage,
} from "./search.js";
import { digest } from "./execution.js";
import { fail } from "./errors.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { workEventFilter } from "../../protocol/src/work-events.js";

export interface HistoryContext {
  db: DatabaseSync;
  search: MemorySearch;
  get(id: string): Graph;
  persist(graph: Graph): void;
  transaction<T>(fn: () => T): T;
  mutate<T>(id: string, kind: string, observation: boolean, fn: (graph: Graph) => T): T;
}
const now = () => new Date().toISOString();

export function queryGraphChanges(ctx: HistoryContext, id: string, query: ChangesQuery) {
  const graph = ctx.get(id);
  if (query.through_revision > graph.revision) fail(422, "Changes snapshot is ahead of current graph");
  const high = Number(
    ctx.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM platform_event_history WHERE project_id=?").get(id)!.n,
  );
  const db = ctx.db;
  const workEvent = workEventFilter(graph);
  try {
    return queryChanges(id, query, high, function* (throughSeq) {
      const rows = db
        .prepare(
          "SELECT * FROM platform_event_history WHERE project_id=? AND revision>? AND revision<=? AND seq<=? ORDER BY seq",
        )
        .iterate(id, query.after_revision, query.through_revision, throughSeq);
      for (const row of rows) yield workEvent({ ...row, data: JSON.parse(String(row.data)) } as unknown as Event);
    });
  } catch (error) {
    if (error instanceof ChangesQueryError) return fail(422, error.message);
    throw error;
  }
}

export function searchGraphMemory(ctx: HistoryContext, id: string, keyword: string, kind?: string) {
  ctx.get(id);
  const ids = ctx.search.search(id, keyword, kind);
  return { ids, total: ids.length };
}

export function recordGraphRead(ctx: HistoryContext, id: string, recordId: string) {
  return ctx.transaction(() => {
    const g = ctx.get(id);
    const round = g.project.decision_round ?? 0;
    const nodes = [...g.facts, ...g.steps, ...g.findings, ...g.evidence] as { id: string; last_read_round?: number }[];
    const node = nodes.find((value) => value.id === recordId) || fail(404, "Record not found");
    if ("deleted" in node && node.deleted) return { ok: true, deleted: true };
    if (node.last_read_round === round) return { ok: true };
    node.last_read_round = round;
    ctx.persist(g);
    return { ok: true };
  });
}

export function updateCooldown(
  ctx: HistoryContext,
  id: string,
  input: { hot_limit?: number; hot_char_limit?: number; node_id?: string; override?: "auto" | "pinned" | "cooled" },
) {
  return ctx.mutate(id, "cooldown.updated", false, (g) => {
    if (input.hot_limit !== undefined) {
      if (!Number.isInteger(input.hot_limit) || input.hot_limit < 0 || input.hot_limit > 1000)
        fail(422, "Hot limit must be an integer between 0 and 1000");
      g.project.hot_limit = input.hot_limit;
    }
    if (input.hot_char_limit !== undefined) {
      if (!Number.isInteger(input.hot_char_limit) || input.hot_char_limit < 0 || input.hot_char_limit > 1_000_000)
        fail(422, "Hot character limit must be an integer between 0 and 1000000");
      g.project.hot_char_limit = input.hot_char_limit;
    }
    if (input.node_id) {
      const nodes = [...g.facts, ...g.steps, ...g.findings, ...g.evidence] as {
        id: string;
        cooldown_override?: string;
      }[];
      const node = nodes.find((value) => value.id === input.node_id) || fail(404, "Record not found");
      if ("deleted" in node && node.deleted) fail(409, "Node deleted; cannot return it to the work graph");
      node.cooldown_override = input.override ?? "auto";
    }
    g.project.pool_revision = (g.project.pool_revision ?? 0) + 1;
    return {
      hot_limit: g.project.hot_limit,
      hot_char_limit: g.project.hot_char_limit,
      node_id: input.node_id ?? null,
      override: input.override ?? null,
      pool_revision: g.project.pool_revision,
    };
  });
}

export function peekCold(
  ctx: HistoryContext,
  id: string,
  query: { cursor?: string; limit?: number; kind?: string },
): PeekPage {
  return ctx.transaction(() => {
    const graph = ctx.get(id);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 0 || limit > 200) fail(422, "Peek limit must be between 0 and 200");
    const hotLimit = graph.project.hot_limit ?? 200;
    const savedRevision = Number(
      (ctx.db.prepare("SELECT pool_revision FROM platform_pools WHERE project_id=?").get(id) as any)?.pool_revision ??
        graph.project.pool_revision ??
        0,
    );
    if (!hotLimit)
      return {
        snapshot_revision: graph.revision,
        mode: "peek" as const,
        total: 0,
        seen: 0,
        seed: "",
        pool_revision: savedRevision,
        algorithm: ALGORITHM,
        items: [],
        next_cursor: null,
        disabled: true,
      };
    const pool = coldPool(graph).filter((row) => !query.kind || row.kind === query.kind);
    const fingerprint = digest(pool.map((row) => `${row.kind}:${row.record.id}`).sort());
    const saved = ctx.db.prepare("SELECT * FROM platform_pools WHERE project_id=?").get(id) as
      { pool_revision: number; seed: string; fingerprint: string } | undefined;
    let poolRevision = Number(saved?.pool_revision ?? 0);
    let seed = saved?.seed;
    if (!saved || saved.fingerprint !== fingerprint) {
      poolRevision++;
      seed = randomUUID();
      ctx.db
        .prepare(
          `INSERT INTO platform_pools(project_id,pool_revision,seed,fingerprint,algorithm,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET pool_revision=excluded.pool_revision,
          seed=excluded.seed,fingerprint=excluded.fingerprint,algorithm=excluded.algorithm,updated_at=excluded.updated_at`,
        )
        .run(id, poolRevision, seed, fingerprint, ALGORITHM, now());
    }
    let cursor: PeekCursor | undefined;
    if (query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      } catch {
        fail(422, "Invalid peek cursor");
      }
      if (
        !cursor ||
        cursor.v !== 1 ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        typeof cursor.seed !== "string" ||
        !Array.isArray(cursor.seen) ||
        typeof cursor.pool_revision !== "number"
      )
        fail(422, "Invalid peek cursor");
    }
    const samePool = cursor?.pool_revision === poolRevision;
    const offset = samePool ? cursor!.offset : 0;
    const seen = new Set<string>(cursor?.seen ?? []);
    const ordered = seededShuffle(
      pool.sort((a, b) => a.kind.localeCompare(b.kind) || a.record.id.localeCompare(b.record.id)),
      seed!,
    );
    // Offset walks the shuffled order; `seen` only removes nodes already shown when the pool changed.
    const slice = ordered.slice(offset, offset + limit);
    const page = slice.filter((row) => !seen.has(row.record.id));
    for (const row of page) seen.add(row.record.id);
    const next = offset + slice.length < ordered.length;
    const cursorOut = next
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            pool_revision: poolRevision,
            seed: seed!,
            offset: offset + slice.length,
            seen: [...seen].slice(-2000),
          } satisfies PeekCursor),
        ).toString("base64url")
      : null;
    if ((graph.project.pool_revision ?? 0) !== poolRevision) {
      graph.project.pool_revision = poolRevision;
      ctx.persist(graph);
    }
    return {
      snapshot_revision: graph.revision,
      mode: "peek" as const,
      total: ordered.length,
      seen: seen.size,
      seed: seed!,
      pool_revision: poolRevision,
      algorithm: ALGORITHM,
      items: page.map(peekItem),
      next_cursor: cursorOut,
    };
  });
}

export function readGraphChange(ctx: HistoryContext, id: string, seq: number, offset = 0, limit = 4000) {
  const graph = ctx.get(id);
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 12000
  )
    fail(422, "Invalid event page");
  const row = ctx.db.prepare("SELECT * FROM platform_event_history WHERE project_id=? AND seq=?").get(id, seq);
  if (!row) return fail(404, "Event not found in project");
  // The same scrub as the change list: an event must not republish a deleted
  // node's body just because it was recorded before the deletion.
  const event = workEventFilter(graph)({
    seq: Number(row.seq),
    revision: Number(row.revision),
    project_id: String(row.project_id),
    kind: String(row.kind),
    data: JSON.parse(String(row.data)),
    created_at: String(row.created_at),
  } as Event);
  const content = JSON.stringify(event);
  return {
    event_seq: seq,
    revision: Number(row.revision),
    format: "json",
    offset,
    total_chars: content.length,
    content: content.slice(offset, offset + limit),
    next_offset: offset + limit < content.length ? offset + limit : null,
  };
}
