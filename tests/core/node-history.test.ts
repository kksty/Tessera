import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { readMemoryRecord } from "../../packages/core/src/memory.js";

test("a Finding keeps only its immediately previous snapshot, and model reads never carry version history", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "History", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const finding = store.submitFinding(
      id,
      findingSchema.parse({ title: "Claim v1", description: "Initial claim", evidence_ids: [] }),
    );
    for (let version = 2; version <= 6; version++) store.reviseFinding(id, finding.id, { title: `Claim v${version}` });
    const record = store.get(id).findings[0];
    assert.equal(record.version, 6);
    assert.equal(record.edits?.length, 1, "the node is not an unbounded revision archive");
    assert.equal(record.edits![0].version, 5);
    assert.equal(record.edits![0].previous.title, "Claim v5");
    // The model-facing record is the current claim only; the operator history
    // endpoint is the sole reader of the retained snapshot.
    const current = JSON.parse(readMemoryRecord(store.get(id), finding.id).content!) as Record<string, unknown>;
    assert.equal(current.title, "Claim v6");
    assert.equal("edits" in current, false);
    assert.equal("restored" in current, false);
    const history = JSON.parse(readMemoryRecord(store.get(id), finding.id, 0, 12000, undefined, true).content!);
    assert.equal(history.edits.length, 1);
    assert.equal(history.edits[0].previous.title, "Claim v5");
  } finally {
    store.close();
  }
});
