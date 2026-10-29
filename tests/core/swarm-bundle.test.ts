import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { exportProjectBundle, importProjectBundle } from "../../packages/core/src/bundle.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("swarm 执行者、消息与回合水位随项目备份导出并在导入后恢复", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "tessera-bundle-swarm-source-")),
    targetDir = mkdtempSync(join(tmpdir(), "tessera-bundle-swarm-target-")),
    bundle = join(targetDir, "swarm.zip");
  const source = new Store(join(sourceDir, "tessera.db"));
  let target: Store | undefined;
  try {
    const id = source.create(
      createProjectSchema.parse({
        title: "Swarm bundle",
        origin: "https://swarm.example.test",
        goal: "Assess",
        mode: "swarm",
      }),
    ).project.id;
    const job = source.claim(id, "w1", 0)!;
    const child = source.swarmSpawn(id, "p001", { reason: "split auth", direction: "auth" }, job.run_id!);
    source.swarmSendMessage(id, "p001", { to: child.id, kind: "handoff", body: "check login", refs: [] }, job.run_id!);
    source.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "done" }, job.run_id!);
    source.release(id, job);

    const manifest = await exportProjectBundle(source, id, bundle);
    assert.equal(manifest.counts.peers, 2, "manifest counts peers");
    // spawn 的系统消息 + handoff 各一条。
    assert.equal(manifest.counts.messages, 2, "manifest counts messages");
    assert.ok(
      manifest.contents.some((entry) => entry.startsWith("messages-")),
      "manifest lists the messages section",
    );
    assert.ok(
      manifest.contents.some((entry) => entry.startsWith("peer-state-")),
      "manifest lists the peer-state section",
    );
    target = new Store(join(targetDir, "tessera.db"));
    await importProjectBundle(target, bundle);
    const graph = target.get(id);
    assert.equal(graph.project.mode, "swarm");
    assert.equal(graph.peers?.length, 2, "peers survive the bundle");
    const messages = target.swarmMessages(id);
    assert.equal(messages.length, 2, "messages survive the bundle");
    assert.equal(messages[0].kind, "system", "the spawn notice survives too");
    assert.equal(messages[1].body, "check login");
    assert.equal(messages[1].to_peer, child.id);
    assert.ok(target.swarm.states(id).get("p001"), "peer turn state survives the bundle");
  } finally {
    source.close();
    target?.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("导入的 active swarm 项目会重新唤醒处于 waiting 的执行者，而不是静默停摆", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "tessera-bundle-swarm-wait-source-")),
    targetDir = mkdtempSync(join(tmpdir(), "tessera-bundle-swarm-wait-target-")),
    bundle = join(targetDir, "waiting.zip");
  const source = new Store(join(sourceDir, "tessera.db"));
  let target: Store | undefined;
  try {
    const id = source.create(
      createProjectSchema.parse({
        title: "Waiting swarm",
        origin: "https://swarm.example.test",
        goal: "Assess",
        mode: "swarm",
      }),
    ).project.id;
    const job = source.claim(id, "w1", 0)!;
    source.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "nothing left this turn" }, job.run_id!);
    source.release(id, job);
    // 源实例里已无可领取的工作：水位追平、没有未读消息。
    assert.equal(source.claim(id, "w2", 0), null);
    await exportProjectBundle(source, id, bundle);
    target = new Store(join(targetDir, "tessera.db"));
    await importProjectBundle(target, bundle);
    const imported = target.claim(id, "w1", 0);
    assert.equal(imported?.kind, "peer", "import must re-arm active peers whose leases came from the source instance");
    assert.equal(imported?.peer_id, "p001");
  } finally {
    source.close();
    target?.close();
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
