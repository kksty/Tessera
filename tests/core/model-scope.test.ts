import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

function project(store: Store) {
  return store.create(
    createProjectSchema.parse({
      title: "Model scope",
      origin: "https://seed.example.test",
      goal: "Assess",
    }),
  ).project.id;
}

test("discovered assets are usable without a separate approval step", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const [asset] = store.discover(id, [
      { hostname: "new.example.test", source: "discovery", evidence_ids: [] },
    ]);
    assert.equal(asset.approval, "approved");
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "测新资产",
      creator: "human",
      asset_id: asset.id,
      claim: true,
    });
    assert.equal(step.worker, "human");
  } finally {
    store.close();
  }
});

test("an operator revocation is still a hard stop", () => {
  const store = new Store(":memory:");
  try {
    const id = project(store);
    const [asset] = store.discover(id, [
      { hostname: "revoked.example.test", source: "discovery", evidence_ids: [] },
    ]);
    store.revokeAssets(id, [asset.id]);
    assert.throws(
      () =>
        store.manualStep(id, {
          from: ["origin"],
          description: "撤销后不得再测",
          creator: "human",
          asset_id: asset.id,
        }),
      /revoked/,
    );
  } finally {
    store.close();
  }
});
