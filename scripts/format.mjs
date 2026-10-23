import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as prettier from "prettier";

// Existing unformatted files have a content baseline. Any future edit must format the whole file.
// This avoids mixing a repository-wide formatting rewrite with behavioral changes.
const baseline = JSON.parse(readFileSync(new URL("./format-baseline.json", import.meta.url), "utf8"));
const write = process.argv.includes("--write");
let failed = false;
for (const root of ["apps", "packages", "scripts", "tests"]) {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|tsx|mjs|cjs)$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name).replaceAll("\\", "/");
    if (/(?:^|\/)(?:node_modules|dist|test-results)\//.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
    if ([baseline[file]].flat().includes(hash)) continue;
    const config = { ...(await prettier.resolveConfig(file)), filepath: file };
    if (write) writeFileSync(file, await prettier.format(source, config));
    else if (!(await prettier.check(source, config))) {
      console.error(`Format required: ${file}`);
      failed = true;
    }
  }
}
process.exitCode = failed ? 1 : 0;
