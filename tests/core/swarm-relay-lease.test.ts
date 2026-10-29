import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { runRelayLease } from "../../apps/server/src/model-relay.js";

test("a peer Run's model relay lease comes from its own heartbeat, not a missing finding", () => {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Swarm relay", origin: "https://example.test", goal: "Assess", mode: "swarm" }),
  ).project.id;
  const job = store.claim(id, "w1", 0)!;
  assert.equal(job.kind, "peer");
  const run = store.execution.get(id, job.run_id!)!;
  const lease = runRelayLease(store.get(id), run);
  // Before the fix the peer branch fell through to the review lookup → undefined → 409.
  assert.equal(lease, run.heartbeat_at);
  assert.ok(lease && Date.now() - Date.parse(lease) < store.leaseSeconds * 1000, "fresh peer lease is within TTL");
});
