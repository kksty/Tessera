import type { DatabaseSync } from "node:sqlite";
import type { Graph } from "../../protocol/src/models.js";

export const graphCollections = [
  "facts",
  "goals",
  "steps",
  "leads",
  "hints",
  "findings",
  "assets",
  "evidence",
  "reviews",
  "usage",
  "bookmarks",
] as const;

/** Header and records are separate: a heartbeat no longer rewrites all Evidence/Facts. */
export class GraphStorage {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS platform_graph_records(
      project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
      collection TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(project_id,collection,id));
      CREATE INDEX IF NOT EXISTS graph_record_order ON platform_graph_records(project_id,collection,position);`);
  }
  load(id: string, data: string): Graph {
    const graph = JSON.parse(data);
    // Legacy arrays are read as-is; the next successful mutation migrates atomically.
    const normalized = graph.storage_version === 1;
    const present = graph.storage_collections || graphCollections;
    delete graph.storage_version;
    delete graph.storage_collections;
    if (normalized) {
      const rows = this.db
        .prepare("SELECT collection,data FROM platform_graph_records WHERE project_id=? ORDER BY collection,position")
        .all(id);
      for (const key of present) graph[key] = [];
      for (const row of rows) graph[String(row.collection)].push(JSON.parse(String(row.data)));
    }
    return graph as Graph;
  }
  save(graph: Graph, before?: Graph) {
    const header: Record<string, unknown> = {
      ...graph,
      storage_version: 1,
      storage_collections: graphCollections.filter((key) => graph[key] !== undefined),
    };
    for (const key of graphCollections) delete header[key];
    const wasNormalized =
      this.db
        .prepare("SELECT json_extract(data,'$.storage_version') AS v FROM platform_projects WHERE id=?")
        .get(graph.project.id)?.v === 1;
    this.db
      .prepare(
        `INSERT INTO platform_projects VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,status=excluded.status,data=excluded.data WHERE data!=excluded.data`,
      )
      .run(graph.project.id, graph.project.title, graph.project.status, JSON.stringify(header));
    const upsert = this.db
      .prepare(`INSERT INTO platform_graph_records VALUES(?,?,?,?,?) ON CONFLICT(project_id,collection,id)
      DO UPDATE SET position=excluded.position,data=excluded.data WHERE position!=excluded.position OR data!=excluded.data`);
    const remove = this.db.prepare("DELETE FROM platform_graph_records WHERE project_id=? AND collection=? AND id=?");
    for (const key of graphCollections) {
      const previous = new Map(
        (wasNormalized && before ? (before[key] ?? []) : []).map((record, position) => [
          record.id,
          { position, data: JSON.stringify(record) },
        ]),
      );
      const records = graph[key] ?? [];
      for (const [position, record] of records.entries()) {
        const data = JSON.stringify(record),
          old = previous.get(record.id);
        if (!old || old.data !== data || old.position !== position)
          upsert.run(graph.project.id, key, record.id, position, data);
        previous.delete(record.id);
      }
      for (const id of previous.keys()) remove.run(graph.project.id, key, id);
    }
  }
}
