import { test } from "node:test";
import assert from "node:assert/strict";
import { filterFinalFacts } from "../../packages/runner/src/fact-payload.js";
import { factSubmissionSchema } from "../../packages/protocol/src/index.js";

// The payload shape is the one observed in proj_05469fe3: the model listed the
// facts it had already submitted, by node id, in the final execute result.

test("final facts keep new observations and drop node-id references", () => {
  const { facts, filtered } = filterFinalFacts(
    ["f002", "s004", "v003", "f013", "Login page returned 302 after valid credentials"],
    ["f002", "s004", "v003"],
    [],
  );
  assert.deepEqual(facts, [{ description: "Login page returned 302 after valid credentials", evidence_ids: [] }]);
  // s004/v003 are not in the snapshot but still look like node names.
  assert.deepEqual(filtered, { reference: 4, duplicate: 0 });
});

test("observations already persisted through submit_fact are not created twice", () => {
  const recorded = ["Admin endpoint accepted an unauthenticated request"];
  const { facts, filtered } = filterFinalFacts(
    [
      { description: "Admin endpoint accepted an unauthenticated request", evidence_ids: ["e1"] },
      "Admin endpoint accepted an unauthenticated request   ",
      "Unrelated second observation",
    ],
    [], recorded,
  );
  assert.deepEqual(facts, [{ description: "Unrelated second observation", evidence_ids: [] }]);
  assert.deepEqual(filtered, { reference: 0, duplicate: 2 });
});

test("structured facts pass through with their own fields intact", () => {
  const structured = { description: "TLS certificate is expired", conclusion: "expired", status: "observed" as const, evidence_ids: ["e9"] };
  const { facts } = filterFinalFacts([structured], [], []);
  assert.equal(facts[0], structured);
});

test("the model-facing fact contract matches the store and rejects references", () => {
  const accepted = factSubmissionSchema.safeParse({ description: "Port 22 is open" });
  assert.ok(accepted.success);
  assert.deepEqual(accepted.data.evidence_ids, []);
  // `from` is a Step/Finding reference, not a Fact column: reject it before upload
  // instead of letting the store answer 422 after the model wrote the observation.
  assert.equal(factSubmissionSchema.safeParse({ description: "x", from: ["s004"] }).success, false);
  assert.equal(factSubmissionSchema.safeParse({ description: "" }).success, false);
  assert.equal(factSubmissionSchema.safeParse({ description: "x", conclusion: "y".repeat(200) }).success, false);
});
