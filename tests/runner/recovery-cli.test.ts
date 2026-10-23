import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../../packages/core/src/store.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { projectToken } from "../../packages/protocol/src/internal-auth.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { SubmissionOutbox } from "../../packages/runner/src/submissions.js";

test("saved-result recovery CLI replays with only a project token and does not require a global credential in the Worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-recovery-cli-")),
    store = new Store(join(dir, "graph.db"));
  const app = buildApp(store, new RuntimeConfig(join(dir, "runtime.json")), join(dir, "no-web"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Recovery", origin: "https://example.test", goal: "fixture" }),
    ).project.id;
    const job = store.claim(id, "worker", 0)!;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const token = projectToken(testWorkerToken, id),
      client = new ApiClient(app.listeningOrigin, token);
    const file = await new SubmissionOutbox(dir, job, client).prepare(client.projectPath(job, "/fgs/bookmarks"), {
      worker: job.worker,
      node_id: "origin",
      expected_version: 0,
      reason: "关注",
      revisit_when: "条件变化",
    });
    const run = (project: string, global: string) =>
      new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            resolve("packages/runner/src/recover.ts"),
            "--server",
            app.listeningOrigin,
            "--file",
            file,
          ],
          {
            windowsHide: true,
            env: { ...process.env, TESSERA_PROJECT_TOKEN: project, TESSERA_WORKER_TOKEN: global },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          output += data;
        });
        child.once("error", reject);
        child.once("close", (code) => resolveResult({ code, output }));
      });
    const result = await run(token, "");
    assert.equal(result.code, 0, result.output);
    assert.equal(store.get(id).bookmarks?.length, 1);
    assert.ok(!result.output.includes(token));
    const oldInvocation = await run("", testWorkerToken);
    assert.equal(oldInvocation.code, 1);
    assert.match(oldInvocation.output, /TESSERA_PROJECT_TOKEN/);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
