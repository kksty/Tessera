import { createHash } from "node:crypto";
import type { Event } from "../../protocol/src/index.js";
import { memoryKinds } from "./memory.js";

export interface ChangesQuery {
  after_revision: number;
  through_revision: number;
  cursor?: string;
  limit?: number;
}
export class ChangesQueryError extends Error {}
function semantic(event: Event): "recorded" | false {
  return event.data.semantic === true ? "recorded" : false;
}

/** Immutable event interval, latest semantic revision per record, bounded previews, no usage/lease wakeups. */
export function queryChanges(
  projectId: string,
  query: ChangesQuery,
  highestSeq: number,
  events: (throughSeq: number) => Iterable<Event>,
  maxChars = 8000,
) {
  const { after_revision: after, through_revision: through, limit = 20 } = query;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(through) ||
    through < after ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > 100 ||
    maxChars < 1000
  )
    throw new ChangesQueryError("Invalid changes interval, limit or budget");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([projectId, after, through]))
    .digest("hex");
  let offset = 0,
    throughSeq = highestSeq;
  if (query.cursor) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
    } catch {
      throw new ChangesQueryError("Invalid changes cursor");
    }
    if (!parsed || typeof parsed !== "object") throw new ChangesQueryError("Invalid changes cursor");
    if (
      parsed.fingerprint !== fingerprint ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      !Number.isSafeInteger(parsed.through_seq) ||
      parsed.through_seq < 0 ||
      parsed.through_seq > highestSeq
    )
      throw new ChangesQueryError("Changes cursor does not match this project/interval");
    offset = parsed.offset;
    throughSeq = parsed.through_seq;
  }
  type Item = {
    kind: string;
    id: string;
    revision: number;
    event_seq: number;
    event_kind: string;
    semantic_source: string;
    preview: string;
    preview_truncated: boolean;
    deleted?: boolean;
    history_ref?: string;
  };
  const latest = new Map<string, Item>();

  for (const event of events(throughSeq)) {
    if (event.project_id !== projectId || event.revision <= after || event.revision > through || event.seq > throughSeq)
      continue;
    const source = semantic(event);
    if (!source) continue;
    const changes = (event.data.changes ?? event.data.snapshot ?? {}) as Record<string, unknown>;
    let nodeCount = 0;
    for (const kind of memoryKinds) {
      if (!Array.isArray(changes[kind])) continue;
      for (const r of changes[kind] as Record<string, unknown>[]) {
        if (typeof r.id !== "string") continue;
        // Leads carry surface/why rather than description/content.
        const text = String(
          kind === "leads"
            ? [r.surface, r.why, r.waiver_reason].filter(Boolean).join(" — ")
            : (r.description ?? r.content ?? r.title ?? r.reason ?? r.summary ?? r.hostname ?? ""),
        );
        const previous = latest.get(`${kind}:${r.id}`);
        if (
          !previous ||
          previous.revision < event.revision ||
          (previous.revision === event.revision && previous.event_seq < event.seq)
        )
          latest.set(`${kind}:${r.id}`, {
            kind,
            id: r.id,
            revision: event.revision,
            event_seq: event.seq,
            event_kind: event.kind,
            semantic_source: source,
            preview: text.slice(0, 180),
            preview_truncated: text.length > 180,
            ...(r.deleted ? { deleted: true } : {}),
            ...(typeof r.history_ref === "string" ? { history_ref: r.history_ref } : {}),
          });
        nodeCount++;
      }
    }
    if (!nodeCount)
      latest.set(`event:${event.seq}`, {
        kind: "event",
        id: String(event.seq),
        revision: event.revision,
        event_seq: event.seq,
        event_kind: event.kind,
        semantic_source: source,
        preview: event.kind,
        preview_truncated: false,
      });
  }
  const rows = [...latest.values()].sort(
    (a, b) => a.event_seq - b.event_seq || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
  const items: Item[] = [];
  const result = (next: number) => ({
    after_revision: after,
    through_revision: through,
    through_seq: throughSeq,
    total: rows.length,
    items,
    remaining: Math.max(0, rows.length - next),
    next_cursor:
      next < rows.length
        ? Buffer.from(JSON.stringify({ fingerprint, offset: next, through_seq: throughSeq })).toString("base64url")
        : null,
  });
  for (const item of rows.slice(offset, offset + limit)) {
    items.push(item);
    if (JSON.stringify(result(offset + items.length)).length > maxChars) {
      items.pop();
      break;
    }
  }
  if (limit && !items.length && offset < rows.length)
    throw new ChangesQueryError("Changes identifier exceeds page budget");
  return result(offset + items.length);
}
export type ChangesPage = ReturnType<typeof queryChanges>;
