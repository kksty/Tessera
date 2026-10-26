// Verify the platform database after moving /data to a named volume.
//
//   node scripts/ops/verify-data-volume.mjs <db-file> [evidence-dir]
//
// Exit code 0 only when the database is structurally sound and the expected
// tables are readable. Intended to run on the host right after the volume copy;
// it opens the file read-only so it can also audit a stopped deployment.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.argv[2];
const evidenceDir = process.argv[3];
if (!dbPath) {
  console.error("usage: node scripts/ops/verify-data-volume.mjs <db-file> [evidence-dir]");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
let failures = 0;
const report = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

const quick = db.prepare("PRAGMA quick_check").all();
report(
  quick.every((row) => row.quick_check === "ok"),
  "PRAGMA quick_check",
  quick.map((row) => row.quick_check).join("; "),
);

const count = (sql) => {
  try {
    return db.prepare(sql).get()?.c ?? 0;
  } catch (error) {
    report(false, sql, error.message);
    return 0;
  }
};

const projects = count("SELECT COUNT(*) c FROM platform_projects");
const runs = count("SELECT COUNT(*) c FROM platform_runs");
const evidence = count("SELECT COUNT(*) c FROM platform_graph_records WHERE collection='evidence'");
const facts = count("SELECT COUNT(*) c FROM platform_graph_records WHERE collection='facts'");
const findings = count("SELECT COUNT(*) c FROM platform_graph_records WHERE collection='findings'");
report(projects > 0, "projects", String(projects));
console.log(`     runs=${runs} facts=${facts} findings=${findings} evidence=${evidence}`);

const stored = db.prepare("SELECT data FROM platform_projects").all();
let unreadable = 0;
for (const row of stored) {
  try {
    const header = JSON.parse(String(row.data));
    if (header.format_version !== 1) unreadable++;
  } catch {
    unreadable++;
  }
}
report(unreadable === 0, "project headers parse", unreadable ? `${unreadable} unreadable` : "");

if (evidenceDir) {
  if (!existsSync(evidenceDir)) {
    report(false, "evidence directory", `${evidenceDir} not found`);
  } else {
    let files = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) files++;
      }
    };
    walk(evidenceDir);
    report(files > 0, "evidence files", `${files} under ${evidenceDir}`);
    const size = statSync(dbPath).size;
    console.log(`     database ${(size / 1024 / 1024).toFixed(1)} MiB`);
  }
}

db.close();
process.exit(failures ? 1 : 0);
