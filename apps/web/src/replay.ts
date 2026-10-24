import type { Event, Graph } from "../../../packages/protocol/src/index.js";
import { activeGraph } from "../../../packages/protocol/src/node-lifecycle.js";

export function changedIds(data: unknown, out: string[] = []): string[] {
  if (Array.isArray(data)) for (const value of data) changedIds(value, out);
  else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.id === "string") out.push(record.id);
    for (const value of Object.values(record)) if (value && typeof value === "object") changedIds(value, out);
  }
  return out;
}

/** 黑板真正画出来的节点类型；只有它们变化才会改变画面。 */
const boardNodeKinds = ["facts", "steps", "goals", "findings", "hints"] as const;

/** 用量、证据、报告、运行状态等事件也会写进历史，但不会改变黑板上的图。
 *  时间线与回放只取「图有变化」的时刻，否则一次执行里成百上千条
 *  usage.recorded / evidence.saved 会把真正的探索推进淹没。 */
export function changesBlackboard(event: Event): boolean {
  if (event.data.snapshot) return true;
  const changes = event.data.changes as Record<string, unknown> | undefined;
  if (!changes) return false;
  return boardNodeKinds.some((kind) => {
    const value = changes[kind];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
}

/** 只保留会改变黑板画面的历史时刻，顺序不变。 */
export function blackboardEvents(events: Event[]): Event[] {
  return events.filter(changesBlackboard);
}

/** 全量事件序号 → 下标：取该时刻之前最近的一条事件。 */
function eventIndexAt(events: Event[], seq: number): number {
  let index = -1;
  for (let offset = 0; offset < events.length; offset++) {
    if (events[offset].seq > seq) break;
    index = offset;
  }
  return index;
}

/** 全量事件序号 → 黑板时间点下标：取该时刻之前最近的一次图变化。
 *  项目时间线里的关注事件（如运行失败）本身不改变画面，回放时停在它之前的图上。 */
export function blackboardIndexAt(events: Event[], seq: number): number {
  return eventIndexAt(events, seq);
}

/** 回放第 index 个图变化。重建图仍读完整事件，证据、用量等时点的细节不会丢，
 *  只是它们本身不占用时间线里的位置。 */
export function replayBoard(events: Event[], timeline: Event[], index: number): Graph | null {
  const event = timeline[index];
  return event ? replay(events, eventIndexAt(events, event.seq)) : null;
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
