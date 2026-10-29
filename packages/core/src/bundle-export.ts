import { existsSync, readFileSync } from "node:fs";
import { DiagnosticRecords, diagnosticBuild } from "./diagnostics.js";
import { fail } from "./errors.js";
import { GraphStorage } from "./graph-storage.js";
import { writeZip, type ZipEntry } from "./archive.js";
import type { Store } from "./store.js";
import type { Graph } from "../../protocol/src/index.js";
import {
  BUNDLE_SCHEMA,
  BundleManifest,
  ChunkWriter,
  README,
  bundleTempRoot,
  cleanStaleBundles,
  ensureDirectory,
  openReadConnection,
  sha256,
} from "./bundle-shared.js";

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
      peers: graph.peers?.length ?? 0,
      rounds: graph.rounds?.length ?? 0,
      messages: count("SELECT COUNT(*) AS n FROM project_messages WHERE project_id=?", projectId),
      peer_state: count("SELECT COUNT(*) AS n FROM project_peer_state WHERE project_id=?", projectId),
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
        "messages-*.ndjson",
        "peer-state-*.ndjson",
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
      // swarm：平等执行者的消息与回合水位（独立表，不属于图集合）。
      yield* category(
        "messages",
        db
          .prepare(
            "SELECT seq,id,from_peer,to_peer,kind,body,refs,created_at FROM project_messages WHERE project_id=? ORDER BY seq",
          )
          .iterate(projectId) as IterableIterator<any>,
      );
      yield* category(
        "peer-state",
        db
          .prepare(
            "SELECT peer_id,wake,seen_revision,seen_message_seq,turn_start_revision,turn_start_message_seq,turns,last_turn_at,summary FROM project_peer_state WHERE project_id=? ORDER BY peer_id",
          )
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
