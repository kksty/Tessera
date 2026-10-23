import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url), { recursive: true })
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => `tests/${file}`);
if (!files.length) throw new Error("No TypeScript tests found");
const options = process.argv.slice(2);
if (options[0] === "--") options.shift();
// Pi/process integration cases have real deadlines; bound file-level contention.
if (!options.some((option) => option.startsWith("--test-concurrency"))) options.unshift("--test-concurrency=4");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...options, ...files], {
  cwd: root,
  // Unit/integration fixtures use the bundled catalog; remote refresh is tested against a local server.
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
