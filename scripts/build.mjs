import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
await mkdir("dist", { recursive: true });
const sourceHash = createHash("sha256");
for (const root of ["apps", "packages", "scripts", "docker"]) {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(file => !/[\\/](?:node_modules|dist|__pycache__)[\\/]/.test(file)).sort();
  for (const file of files) sourceHash.update(file.replaceAll("\\", "/")).update("\0").update(readFileSync(file)).update("\0");
}
for (const file of ["package.json", "pnpm-lock.yaml"]) sourceHash.update(file).update(readFileSync(file));
const packageInfo = JSON.parse(readFileSync("package.json", "utf8"));
const buildInfo = { id: sourceHash.digest("hex"), version: packageInfo.version,
  pi_sdk: packageInfo.dependencies["@earendil-works/pi-coding-agent"] };
await build({
  entryPoints: {
    server: "apps/server/src/main.ts",
    dispatcher: "apps/dispatcher/src/main.ts",
    runner: "packages/runner/src/main.ts",
    recover: "packages/runner/src/recover.ts",
    "recover-closeout": "packages/runner/src/recover-closeout.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: true,
  define: { __TESSERA_BUILD_INFO__: JSON.stringify(buildInfo) },
});
await viteBuild({ configFile: "apps/web/vite.config.ts" });
