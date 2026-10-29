import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, executeSchema } from "../../packages/protocol/src/index.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { firstSentence } from "../../packages/core/src/projection.js";

test("every write path records a full conclusion and a three-state status", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Conclusion", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const planner = store.claim(id, "planner", 0)!;
    let graph = store.get(id);
    commitPlan(
      store,
      id,
      decideSchema.parse({
        worker: planner.worker,
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        steps: [{ from: ["origin"], description: "Probe the endpoint" }],
      }),
    );
    const executor = store.claim(id, "executor", 0)!;
    store.execute(
      id,
      executor.step_id!,
      executeSchema.parse({
        worker: executor.worker,
        facts: [
          {
            description: "GET /admin returned 200 with the login page. Body length 4211.",
            conclusion: "/admin 无需认证即可访问",
            status: "observed",
            objects: ["example.test:443/admin"],
            evidence_ids: [],
          },
          {
            description: "POST /admin rejected anonymous writes.",
            conclusion: "匿名写入被拒绝",
            status: "not_observed",
            request: { method: "POST", url: "https://example.test/admin" },
            negative_scope: {
              attempted: ["one anonymous POST to /admin"],
              not_tested: ["authenticated requests"],
              confidence: "low",
            },
            evidence_ids: [],
          },
          {
            description: "Two responses disagreed about the session cookie.",
            conclusion: "会话状态存在争议",
            status: "disputed",
            evidence_ids: [],
          },
          "Legacy string observation without an explicit conclusion. More detail follows.",
        ],
        summary: "Probed",
      }),
    );
    graph = store.get(id);
    const facts = graph.facts.filter((f) => f.id !== "origin");
    assert.deepEqual(
      facts.map((f) => f.status),
      ["observed", "not_observed", "disputed", "observed"],
    );
    assert.equal(facts[0].conclusion, "/admin 无需认证即可访问");
    assert.deepEqual(facts[0].objects, ["example.test:443/admin"]);
    assert.equal(facts[0].conclusion_inferred, undefined);
    // A legacy string fact still gets a conclusion, but it is marked as inferred.
    assert.equal(facts[3].conclusion, "Legacy string observation without an explicit conclusion.");
    assert.equal(facts[3].conclusion_inferred, true);

    // The projection always shows the conclusion in full and only cuts the body.
    store.hint(id, "重新审视结论");
    const decideJob = store.claim(id, "planner", 0)!;
    assert.equal(decideJob.kind, "decide");
    const entry = memoryEntry(store.get(id), decideJob);
    const line = entry.facts.find((l) => l.startsWith(facts[0].id))!;
    assert.match(line, /\/admin 无需认证即可访问/);
    assert.match(line, /observed/);
    assert.match(
      entry.facts.find((l) => l.startsWith(facts[3].id))!,
      /（推断）/,
    );
  } finally {
    store.close();
  }
});

test("firstSentence prefers a sentence boundary and only then cuts", () => {
  assert.equal(firstSentence("短句。第二句。", 300), "短句。第二句。");
  assert.equal(firstSentence("一".repeat(500), 300).length, 301); // 300 chars + ellipsis
  const long = "第一句很重要。" + "细节".repeat(400);
  assert.equal(firstSentence(long, 300), "第一句很重要。");
  assert.ok(firstSentence("无标点".repeat(300), 300).endsWith("…"));
});
