import type { Event, Graph } from "../../../packages/protocol/src/index.js";
import { activeGraph } from "../../../packages/protocol/src/node-lifecycle.js";

export function changedIds(data: unknown, out: string[] = []): string[] {
  if (Array.isArray(data)) for (const value of data) changedIds(value, out);
  else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.id === "string") out.push(record.id);
    for (const value of Object.values(record))
      if (value && typeof value === "object") changedIds(value, out);
  }
  return out;
}

export function replay(events: Event[], index: number): Graph | null {
  let result: Graph | null = null;
  for (const e of events.slice(0, index + 1)) {
    if (e.data.snapshot) result = structuredClone(e.data.snapshot) as Graph;
    else if (result && e.data.changes) {
      const changes = e.data.changes as Record<string, any>;
      for (const [key, values] of Object.entries(changes)) {
        if (Array.isArray(values)) {
          if (key === "bookmarks") result.bookmarks ??= [];
          const current = (result as any)[key] as { id: string }[];
          if (!current) continue;
          for (const item of values) {
            const i = current.findIndex((v) => v.id === item.id);
            if (i < 0) current.push(item);
            else current[i] = item;
          }
        } else (result as any)[key] = values;
      }
      result.revision = e.revision;
    }
  }
  return result ? activeGraph(result) : null;
}
