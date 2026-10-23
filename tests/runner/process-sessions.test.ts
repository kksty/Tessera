import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessSessions } from "../../packages/runner/src/process-sessions.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (script: string) => `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(script)}`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-process-"));
  const manager = new ProcessSessions(join(dir, "processes"), dir, { project_id: "project", run_id: "run", step_id: "step", worker: "worker" });
  return { manager, dir, async close() { await manager.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("long shell calls yield without terminating, retain output and isolate process ownership", async () => {
  const f = fixture(), other = fixture();
  try {
    const id = await f.manager.start(command("console.log('started');setTimeout(()=>console.log('finished'),1200)"));
    assert.equal((await f.manager.poll(id, 0)).status, "running");
    await assert.rejects(other.manager.poll(id, 0), /does not belong/);
    const ended = await f.manager.poll(id, 5000, 0);
    assert.equal(ended.status, "exited");
    assert.equal(ended.exit_code, 0);
    assert.match(ended.output, /started[\s\S]*finished/);
    assert.equal(readFileSync(ended.log_path, "utf8"), ended.output);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "processes", `${id}.json`), "utf8")).run_id, "run");
  } finally { await f.close(); await other.close(); }
});

test("poll output pages preserve UTF-8 and byte offsets", async () => {
  const f = fixture();
  try {
    const id = await f.manager.start(command("process.stdout.write('中'.repeat(5001))"));
    const first = await f.manager.poll(id, 5000, 0);
    const next = await f.manager.poll(id, 0, first.next_offset);
    assert.equal(first.has_more, true);
    assert.equal(next.has_more, false);
    assert.equal(first.output + next.output, "中".repeat(5001));
    assert.equal(next.next_offset, 15003);
  } finally { await f.close(); }
});

test("model deadlines, explicit stop and Run closure terminate commands without marking success", async () => {
  const f = fixture();
  try {
    const slow = command("console.log('waiting');setTimeout(()=>console.log('must-not-finish'),10000)");
    const timed = await f.manager.start(slow, 0.5);
    const result = await f.manager.poll(timed, 5000, 0);
    assert.equal(result.status, "timed_out");
    assert.doesNotMatch(result.output, /must-not-finish/);
    const stopped = await f.manager.start(slow);
    assert.equal((await f.manager.stop(stopped)).status, "stopped");
    const abandoned = await f.manager.start(slow);
    assert.deepEqual(await f.manager.close(), [abandoned]);
    assert.equal((await f.manager.poll(abandoned, 0)).status, "stopped");
    await assert.rejects(f.manager.start("echo rejected"), /no longer accepts/);
    await assert.rejects(f.manager.start(slow, Infinity));
  } finally { await f.close(); }
});
