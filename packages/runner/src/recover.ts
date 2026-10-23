import { parseArgs } from "node:util";
import { ApiClient } from "./client.js";
import { loadSubmission, replaySubmission } from "./submissions.js";

// Deliberately replays one saved operation only: no Pi session, target request, shell, or automatic directory scan.
try {
  const { values } = parseArgs({ options: { server: { type: "string" }, file: { type: "string" } }, strict: true });
  if (!values.server || !values.file || !process.env.TESSERA_PROJECT_TOKEN)
    throw new Error(
      "Usage: TESSERA_PROJECT_TOKEN=<project token> node dist/recover.mjs --server <Tessera URL> --file <saved submission or pending-result.json>",
    );
  const url = new URL(values.server);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Server must be an HTTP(S) URL without embedded credentials/query/fragment");
  const { record } = await loadSubmission(values.file);
  await replaySubmission(values.file, new ApiClient(url.toString(), process.env.TESSERA_PROJECT_TOKEN));
  console.log(JSON.stringify({ state: "accepted", run_id: record.job.run_id, submission_id: record.submission_id }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Submission replay failed");
  process.exitCode = 1;
}
