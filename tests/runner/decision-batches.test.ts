import { test } from "node:test";
import assert from "node:assert/strict";
import { settlementBatches, SETTLEMENT_BATCH_CHARS } from "../../packages/runner/src/decision-batches.js";

const long = (prefix: string) => `${prefix} ${"证据与影响说明".repeat(200)}`;

function update(id: string, index: number) {
  return { id, expected_version: 1, reason: "Revise", changes: { description: long(`变更 ${index}`) } };
}

const shared = { worker: "planner", revision: 7, observation_revision: 6, planning_revision: 5, graph_id: "main" };

test("a settlement under the budget is sent exactly as the model wrote it", () => {
  const input = { ...shared, finding_updates: [update("v001", 1)], more: false };
  const parts = settlementBatches(input);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], input);
});

test("an oversized settlement is split after the plan/step part, with finding revisions chunked", () => {
  const updates = Array.from({ length: 24 }, (_, index) => update(`v${String(index + 1).padStart(3, "0")}`, index));
  const input = {
    ...shared,
    steps: [{ from: ["origin"], description: "Plan first" }],
    closes: [{ id: "s001", reason: "Done", evidence_ids: [], expected_version: 1 }],
    finding_updates: updates,
    complete: { from: ["origin"], description: "Finish" },
  };
  const parts = settlementBatches(input);
  assert.ok(parts.length > 2, "large Finding revisions need more than one part");
  assert.equal((parts[0].steps as unknown[]).length, 1, "the plan stays in the first part");
  assert.equal(parts[0].complete, undefined);
  for (const part of parts.slice(1)) {
    assert.deepEqual(part.steps, [], "later parts never replay the plan");
    assert.equal(part.plan_id, undefined, "the runner supplies the committed plan id at submit time");
  }
  assert.deepEqual(parts.at(-1)!.complete, input.complete, "completion is carried by the final part");
  assert.equal(parts.at(-1)!.more, false);
  assert.ok(parts.slice(0, -1).every((part) => part.more === true));
  const sent = parts.flatMap((part) => (part.finding_updates as { id: string }[] | undefined) ?? []);
  assert.deepEqual(
    sent.map((item) => item.id),
    updates.map((item) => item.id),
    "every revision appears once and in order",
  );
  // The point of the split is bounded output; each part stays within the budget
  // except the plan part, which cannot be split by the Decide contract.
  for (const part of parts.slice(1))
    assert.ok(JSON.stringify(part).length <= SETTLEMENT_BATCH_CHARS, "each settlement part respects the budget");
});

test("merges are atomic and a manual more keeps every part open", () => {
  const merges = Array.from({ length: 20 }, (_, index) => ({
    target_id: `v${index * 2 + 1}`,
    source_ids: [`v${index * 2 + 2}`],
    expected_versions: { [`v${index * 2 + 1}`]: 1, [`v${index * 2 + 2}`]: 1 },
    reason: long(`合并 ${index}`),
  }));
  const parts = settlementBatches({ ...shared, finding_merges: merges, more: true });
  assert.ok(parts.length > 1);
  assert.ok(
    parts.every((part) => part.more === true),
    "a manually continued settlement never ends the run",
  );
  const sent = parts.flatMap((part) => (part.finding_merges as { target_id: string; source_ids: string[] }[]) ?? []);
  assert.equal(sent.length, merges.length);
  assert.deepEqual(
    sent.map((item) => [item.target_id, ...item.source_ids]),
    merges.map((item) => [item.target_id, ...item.source_ids]),
    "a merge group is never split across parts",
  );
});

test("a plan that alone exceeds the budget is not split", () => {
  const input = {
    ...shared,
    steps: [{ from: ["origin"], description: `一个很长的计划 ${"证据与影响说明".repeat(2000)}` }],
    finding_updates: [update("v001", 1)],
    complete: undefined,
  };
  const parts = settlementBatches(input);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], input);
});
