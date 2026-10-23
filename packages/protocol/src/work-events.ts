import type { Event, Graph } from "./models.js";
import { activeGraph } from "./node-lifecycle.js";

/** Current work indexes must not reintroduce removed bodies from older events.
 * Exact events and replay remain immutable, explicitly accessed history. */
export function workEventFilter(graph: Graph) {
  const view = activeGraph(graph);
  if (!view.deleted_nodes?.length) return (event: Event) => event;
  const refs = new Map((view.deleted_nodes ?? []).map(ref => [ref.id, ref]));
  const kinds = ["facts", "steps", "findings", "goals", "hints", "assets", "evidence", "reviews", "bookmarks"] as const;
  const visible = new Set(kinds.flatMap(kind => (view[kind] ?? []).map(node => node.id)));
  const steps = new Map(view.steps.filter(step => step.deleted_output_ids?.length).map(step => [step.id, step]));
  const scrub = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([kind, value]) => {
    if (!kinds.includes(kind as typeof kinds[number]) || !Array.isArray(value)) return [kind, value];
    return [kind, value.map((record: Record<string, unknown>) => {
      const id = String(record.id), ref = refs.get(id);
      if (ref || !visible.has(id)) return { id, description: ref ? "节点已删除" : "仅在显式历史中读取的关联材料",
        deleted: true, deletion_event: !!record.deleted, ...(ref ? { history_ref: ref.history_ref } : {}) };
      const step = steps.get(id);
      return step ? { ...record, summary: step.summary, fact_ids: step.fact_ids, deleted_output_ids: step.deleted_output_ids } : record;
    })];
  }));
  return (event: Event): Event => ({ ...event, data: { ...event.data,
    ...(event.data.changes ? { changes: scrub(event.data.changes as Record<string, unknown>) } : {}),
    ...(event.data.snapshot ? { snapshot: scrub(event.data.snapshot as Record<string, unknown>) } : {}),
  } });
}
