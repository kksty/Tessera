import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerTrace, searchWorkerTraces } from "../../packages/runner/src/trace-search.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "tessera-traces-"));
  await mkdir(join(root, "runs", "w_old"), { recursive: true });
  const lines = [
    {
      run_id: "run_old",
      step_id: "s002",
      kind: "execute",
      at: "2026-10-29T01:00:00.000Z",
      toolName: "http_request",
      args: { url: "https://target.test/api/list", cookie: "SESSION=secret-value" },
      result: "HTTP 200; unusual header X-Debug: parser=legacy",
    },
    {
      run_id: "run_current",
      step_id: "s003",
      kind: "execute",
      at: "2026-10-29T02:00:00.000Z",
      toolName: "http_request",
      args: { url: "https://target.test/api/list" },
      result: "unusual header X-Debug: parser=legacy",
    },
  ];
  await writeFile(join(root, "runs", "w_old", "tools.ndjson"), lines.map((line) => JSON.stringify(line)).join("\n"));
  return root;
}

test("trace search finds an earlier Run, excludes the current one and redacts secrets", async () => {
  const root = await workspace();
  try {
    const found = await searchWorkerTraces(root, "parser=legacy", { excludeRunId: "run_current" });
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].run_id, "run_old");
    assert.equal(found.hits[0].step_id, "s002");
    assert.equal(found.hits[0].matched_in, "result");
    assert.match(found.note, /不是 Evidence/);

    const withCookie = await searchWorkerTraces(root, "target.test", { excludeRunId: "run_current" });
    assert.equal(withCookie.hits.length, 1);
    assert.ok(!withCookie.hits[0].excerpt.includes("secret-value"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace search requires every term and returns nothing for an unknown query", async () => {
  const root = await workspace();
  try {
    assert.equal((await searchWorkerTraces(root, "parser legacy", { excludeRunId: "run_current" })).hits.length, 1);
    assert.equal((await searchWorkerTraces(root, "parser missing-term")).hits.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("get_worker_trace returns the bounded call and redacts credentials", async () => {
  const root = await workspace();
  try {
    const trace = await readWorkerTrace(root, "run_old");
    assert.ok(trace);
    assert.equal(trace!.tool, "http_request");
    assert.match(trace!.args, /\[redacted\]/);
    assert.match(trace!.result, /parser=legacy/);
    assert.equal(trace!.truncated, false);
    assert.equal(await readWorkerTrace(root, "run_missing"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
