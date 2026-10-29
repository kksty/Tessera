import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { collectPendingItems } from "../../apps/server/src/needs-human.js";

function swarm(store: Store, title = "Swarm") {
  return store.create(
    createProjectSchema.parse({ title, origin: "https://example.test", goal: "Assess", mode: "swarm" }),
  ).project.id;
}

test("a stuck swarm peer becomes a needs-human item, not just a UI badge", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    for (let i = 0; i < 3; i++) {
      const job = store.claim(id, `w${i}`, 0)!;
      assert.equal(job.kind, "peer");
      store.release(id, job, "boom");
    }
    const items = collectPendingItems(store);
    const item = items.find((candidate) => candidate.key === `${id}:peers`);
    assert.ok(item, "the Feishu needs-human set must include the parked peer");
    assert.equal(item.kind, "retry");
    assert.match(item.line, /执行者被连续失败停下/);
  } finally {
    store.close();
  }
});

test("a swarm project with no active peer asks for a replacement over the same channel", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const job = store.claim(id, "w1", 0)!;
    store.swarmRetire(id, "p001", { reason: "nothing left" }, job.run_id!);
    store.release(id, job);
    const items = collectPendingItems(store);
    const item = items.find((candidate) => candidate.key === `${id}:peers`);
    assert.ok(item);
    assert.match(item.line, /所有执行者已退出/);
  } finally {
    store.close();
  }
});

test("classic projects never emit the swarm peer item", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Classic", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const items = collectPendingItems(store);
    assert.equal(
      items.some((candidate) => candidate.key === `${id}:peers`),
      false,
    );
  } finally {
    store.close();
  }
});
