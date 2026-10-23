import { runJob } from "./run.js";
import type { DispatchConfig, Job } from "../../protocol/src/index.js";
const job = JSON.parse(
  Buffer.from(process.env.TESSERA_JOB || "", "base64").toString(),
) as Job;
const config = JSON.parse(
  Buffer.from(process.env.TESSERA_RUN_CONFIG || "", "base64").toString(),
) as DispatchConfig;
delete process.env.TESSERA_RUN_CONFIG;
delete process.env.TESSERA_JOB;
try {
  await runJob(job, config, undefined, process.env.TESSERA_WORKSPACE || "/workspace");
  console.log(JSON.stringify({ ok: true, job: job.kind }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Worker failed");
  process.exitCode = 1;
}
