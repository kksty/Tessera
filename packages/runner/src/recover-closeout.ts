import { parseArgs } from "node:util";
import { ApiClient } from "./client.js";
import { recoverReadOnly } from "./read-only-recovery.js";
import type { DispatchConfig } from "../../protocol/src/index.js";

try {
  const { values } = parseArgs({ options: { file: { type: "string" } }, strict: true });
  if (!values.file || !process.env.TESSERA_RUN_CONFIG || !process.env.TESSERA_PROJECT_TOKEN)
    throw new Error("Usage: TESSERA_RUN_CONFIG=<relay config> TESSERA_PROJECT_TOKEN=<project token> node dist/recover-closeout.mjs --file <Run recovery.json>");
  const config: DispatchConfig = JSON.parse(Buffer.from(process.env.TESSERA_RUN_CONFIG, "base64").toString());
  const token = process.env.TESSERA_PROJECT_TOKEN;
  delete process.env.TESSERA_RUN_CONFIG;
  if (process.env.TESSERA_WORKER_TOKEN || !config.model_relay || !new URL(config.model_relay.base_url).pathname.startsWith("/api/model/"))
    throw new Error("Container recovery requires relay configuration and a project-scoped token");
  await recoverReadOnly(values.file, config, new ApiClient(config.server, token));
  console.log(JSON.stringify({ state: "returned", note: "See server Run for commit status" }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Read-only recovery failed");
  process.exitCode = 1;
}
