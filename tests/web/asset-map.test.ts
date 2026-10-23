import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { assetElements } from "../../apps/web/src/AssetMap.js";

test("asset map includes all approvals and derives discovery links only from source evidence", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(createProjectSchema.parse({ title: "Assets", origin: "https://seed.example.test", goal: "Assess" }));
    const template = { hostname: "", id: "", approval: "pending" as const, source: "discovery", evidence_ids: [] as string[], seed: false, created_at: "now" };
    g.assets.push({ ...template, id: "a002", hostname: "child.example.test", evidence_ids: ["e001"] },
      { ...template, id: "a003", hostname: "other.example.test", approval: "rejected" });
    g.evidence.push({ id: "e001", step_id: "s001", title: "Discovery", mime_type: "text/plain", size: 10, sha256: "hash", created_at: "now" });
    g.steps.push({ id: "s001", from: ["origin"], to: null, description: "Discover", priority: 1, discarded: false, creator: "worker", worker: null,
      last_heartbeat_at: null, created_at: "now", concluded_at: null, fact_ids: [], summary: "", graph_id: "main", attempts: 0, asset_id: "a001" });
    const elements = assetElements(g), nodes = elements.filter(e => !e.data.source), edges = elements.filter(e => e.data.source);
    assert.equal(nodes.length, 4);
    assert.equal(edges.filter(e => e.data.relation === "scope").length, 3);
    const links = edges.filter(e => e.data.relation === "discovery");
    assert.equal(links.length, 1);
    assert.equal(links[0].data.source, "a001"); assert.equal(links[0].data.target, "a002");
    assert.deepEqual(links[0].data.evidence_ids, ["e001"]);
    assert.ok(!links.some(e => e.data.target === "a003"), "Similar hostnames alone never imply a relationship");
    assert.ok(edges.every(e => nodes.some(n => n.data.id === e.data.source) && nodes.some(n => n.data.id === e.data.target)));
  } finally { store.close(); }
});
