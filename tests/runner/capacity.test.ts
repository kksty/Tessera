import { test } from "node:test";
import assert from "node:assert/strict";
import { Capacity } from "../../packages/runner/src/capacity.js";

test("compaction invalidates old watermarks; unknown never becomes zero or peak", () => {
  const c = new Capacity(32000, 6000, 3000);
  c.sample(29000); c.start(); c.sample(29000);
  assert.equal(c.current, null);
  c.end(true); c.sample(29000);
  assert.equal(c.current, null);
  c.sample(null, true); assert.equal(c.current, null);
  c.sample(4000, true);
  assert.equal(c.current, 4000); assert.equal(c.peak, 29000);
  assert.equal(c.generation, 1);
  c.start(); c.end(false); assert.equal(c.current, null);
});

test("only first untouched main request checks release; strict threshold and generations", () => {
  const c = new Capacity(32000, 6000, 3000);
  c.start(); c.end(true);
  assert.deepEqual(c.request(), { check: true, generation: 1 });
  assert.equal(c.request().check, false);
  c.start(); c.end(true); c.materialAdded();
  assert.equal(c.request().check, false);
  assert.equal(c.threshold, 26000);
});

test("capacity telemetry accepts SDK budgets without rejecting small windows or zero reserve", () => {
  const small = new Capacity(8192, 16384, 20000);
  assert.equal(small.snapshot().threshold, -8192);
  assert.equal(small.snapshot().reserve, 16384);
  assert.equal(new Capacity(32000, 0, 0).threshold, 32000);
});
