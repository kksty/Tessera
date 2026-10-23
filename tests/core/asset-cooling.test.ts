import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { projectEntry } from "../../packages/core/src/projection.js";
import { createProjectSchema, decideSchema } from "../../packages/protocol/src/index.js";

function decide(store: Store, worker: string, body: Record<string, unknown>) {
  const g = store.get(store.list()[0].id);
  return commitPlan(store, g.project.id, decideSchema.parse({
    worker, revision: g.revision, observation_revision: g.observation_revision, planning_revision: g.planning_revision, ...body,
  }));
}

test("Decide can cool an asset out of its own entry without touching the approval", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(createProjectSchema.parse({ title: "冷却", origin: "10.0.0.5", goal: "拿到 root", hints: [] }));
    const id = g.project.id;
    const planner = store.claim(id, "planner", 0)!;
    decide(store, planner.worker, {
      assets: [{ id: "a001", state: "cooled", reason: "与本轮目标无关", revisit_when: "出现域内凭证时" }],
      steps: [{ from: ["origin"], description: "先看 Web 入口" }],
    });

    const graph = store.get(id);
    const asset = graph.assets.find((a) => a.id === "a001")!;
    assert.equal(asset.cooldown_override, "cooled");
    assert.equal(asset.approval, "approved", "cooling is not a scope change");
    assert.equal(asset.cool_reason, "与本轮目标无关");

    const entry = projectEntry(graph, "goal") as Record<string, any>;
    assert.deepEqual(entry.assets, [], "a cooled asset leaves the planning listing");
    assert.match(entry.cooled_assets.join(","), /a001:10\.0\.0\.5/);
  } finally { store.close(); }
});

test("planning on a cooled asset warms it again; a human can restore it explicitly", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(createProjectSchema.parse({ title: "回热", origin: "10.0.0.5", goal: "拿到 root", hints: [] }));
    const id = g.project.id;
    const first = store.claim(id, "planner", 0)!;
    decide(store, first.worker, { assets: [{ id: "a001", state: "cooled", reason: "先放一边" }] });
    assert.equal(store.get(id).assets[0].cooldown_override, "cooled");

    const second = store.claim(id, "planner", 0);
    if (second) decide(store, second.worker, { steps: [{ from: ["origin"], description: "回头打这台", asset_id: "a001" }] });
    else store.manualStep(id, { from: ["origin"], description: "回头打这台", asset_id: "a001", creator: "user" });
    assert.equal(store.get(id).assets[0].cooldown_override, "auto");

    store.setAssetInterest(id, "a001", "cooled", "人工冷处理");
    assert.equal(store.get(id).assets[0].cooldown_override, "cooled");
    store.setAssetInterest(id, "a001", "auto");
    assert.equal(store.get(id).assets[0].cooldown_override, "auto");
    assert.equal(store.get(id).assets[0].cool_reason, undefined);
  } finally { store.close(); }
});

test("Decide cannot invent assets or touch approval", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(createProjectSchema.parse({ title: "边界", origin: "10.0.0.5", goal: "拿到 root", hints: [] }));
    const planner = store.claim(g.project.id, "planner", 0)!;
    assert.throws(() => decide(store, planner.worker, { assets: [{ id: "a999", state: "cooled" }] }), /Asset not found/);
    // strict 之外的字段被丢弃：模型提交 approval 也不会生效。
    const parsed = decideSchema.parse({ worker: "w", revision: 0, observation_revision: 0,
      assets: [{ id: "a001", state: "cooled", approval: "rejected" }] });
    assert.deepEqual(Object.keys(parsed.assets[0]).sort(), ["id", "state"]);
    assert.equal(store.get(g.project.id).assets[0].approval, "approved");
  } finally { store.close(); }
});
