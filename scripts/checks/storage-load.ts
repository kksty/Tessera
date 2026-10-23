import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import { GraphStorage } from "../../packages/core/src/graph-storage.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import assert from "node:assert/strict";

const directory = mkdtempSync(join(tmpdir(), "tessera-load-"));
const file = join(directory, "load.db");
const withFiles = process.argv.includes("--files");
let store = new Store(file);
const times: Record<string, number> = {};
const measure = <T>(name: string, fn: () => T) => {
  const start = performance.now(),
    result = fn();
  times[name] = Math.round(performance.now() - start);
  return result;
};
try {
  const graph = store.create(
    createProjectSchema.parse({ title: "Storage stress", origin: "https://example.test", goal: "synthetic load" }),
  );
  const bytes = Buffer.from("synthetic raw evidence\n"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  for (let i = 0; i < 500; i++)
    graph.facts.push({ ...graph.facts[0], id: `fact_${i}`, description: `Synthetic observation ${i}` });
  const evidenceDirectory = join(store.evidenceRoot, graph.project.id);
  mkdirSync(evidenceDirectory, { recursive: true });
  measure("seed_ms", () => {
    for (let i = 0; i < 200000; i++) {
      const id = `e${i}`;
      graph.evidence.push({
        id,
        title: `Evidence ${i}`,
        size: bytes.length,
        sha256,
        mime_type: "text/plain",
        indexed: false,
        created_at: new Date().toISOString(),
      });
      if (withFiles) writeFileSync(join(evidenceDirectory, id), bytes);
    }
    store.transaction(() => new GraphStorage(store.db).save(graph));
  });
  measure("read_ms", () => assert.equal(store.get(graph.project.id).evidence.length, 200000));
  // Any collection write here is a regression, even if total elapsed time looks acceptable.
  store.db.exec(
    "CREATE TEMP TRIGGER forbid_rewrite BEFORE UPDATE ON platform_graph_records BEGIN SELECT RAISE(ABORT,'record rewrite'); END",
  );
  const before = Number(store.db.prepare("SELECT total_changes() AS n").get()!.n);
  measure("header_mutation_ms", () =>
    store.mutate(graph.project.id, "", false, (g) => {
      g.project.title = "Renamed under load";
    }),
  );
  const written_rows = Number(store.db.prepare("SELECT total_changes() AS n").get()!.n) - before;
  assert.equal(written_rows, 1);
  store.close();
  measure("restart_ms", () => {
    store = new Store(file);
  });
  assert.equal(store.get(graph.project.id).facts.length, 501);
  const result = {
    nodes: 501,
    evidence: 200000,
    loose_files: withFiles ? 200000 : 0,
    written_rows,
    database_bytes: statSync(file).size,
    ...times,
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    limitation:
      "Full graph reads and mutation comparisons remain O(N); this is a storage stress test, not a concurrency or real-model benchmark.",
  };
  mkdirSync(resolve("test-results"), { recursive: true });
  writeFileSync(resolve("test-results/storage-load.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
