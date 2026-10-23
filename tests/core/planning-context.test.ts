import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, type Graph } from "../../packages/protocol/src/index.js";
import { projectEntry, coldView, OPEN_STEP_PREVIEW_LIMIT } from "../../packages/core/src/projection.js";
import { queryMemory, readMemoryRecord } from "../../packages/core/src/memory.js";

test("open work and current review problems retain direct premises beyond the hot budget, with deleted sources still excluded", () => {
  const store = new Store(":memory:");
  try {
    const g = store.create(createProjectSchema.parse({ title: "Premises", origin: "https://example.test", goal: "Assess" }));
    g.project.hot_limit = 1;
    const step = store.manualStep(g.project.id, { from: ["origin"], description: "Read complete conditions", creator: "human" });
    const graph = store.get(g.project.id);
    graph.facts.push({ id: "f-old", description: "没有关键词提示的必要条件；尾部限制必须保留", conclusion: "旧前提", status: "observed", evidence_ids: [], graph_id: "main" },
      { id: "f-counter", description: "旧前提在当前授权下有争议", conclusion: "前提有争议", status: "disputed", evidence_ids: [], graph_id: "main" },
      { id: "f-new", description: "Unrelated recent observation", conclusion: "Recent", evidence_ids: [], graph_id: "main", last_read_round: 100 });
    graph.steps[0].from = ["f-old"];
    graph.findings.push({ id: "v001", title: "Needs a decision", description: "Claim", kind: "vulnerability", from: ["f-counter"],
      evidence: "", evidence_ids: [], version: 1, reviewed_version: 1, status: "candidate", review_status: "needs_evidence", created_at: "", graph_id: "main" });
    graph.reviews.push({ id: "r001", finding_id: "v001", finding_version: 1, verdict: "needs_evidence", reason: "因果前提不一致，需要决定是否继续",
      evidence_ids: [], disputed_fact_ids: [], worker: "reviewer", created_at: "" });
    assert.equal(coldView(graph).cold.has("f-old"), false);
    assert.equal(coldView(graph).cold.has("f-counter"), false);
    assert.equal(coldView(graph).cold.has("v001"), false);
    const entry = projectEntry(graph, "main");
    assert.ok(entry.facts.some(text => text.startsWith("f-old")));
    assert.deepEqual(entry.review_issues[0].source_fact_ids, ["f-counter"]);
    assert.equal(entry.review_issues[0].read_full.id, "r001");
    graph.facts[1].deleted = { at: "now", by: "planner", submission_id: "delete", reason: "Outdated", root_id: "f-old", cascade: "none" };
    assert.equal(projectEntry(graph, "main").facts.some(text => text.includes("尾部限制")), false);
    assert.equal(projectEntry(graph, "main").deleted_sources?.some(ref => ref.id === "f-old"), true);
  } finally { store.close(); }
});

test("large open boards carry every ID and version and page every complete question from the same snapshot", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Large open board", origin: "https://example.test", goal: "Assess" }));
    const count = OPEN_STEP_PREVIEW_LIMIT + 61;
    for (let i = 0; i < count; i++) graph.steps.push({ id: `s${String(i).padStart(4, "0")}`, version: i + 1,
      from: ["origin"], description: "完整问题".repeat(100) + `不得遗漏的限制-${i}`, priority: 0, discarded: false,
      creator: "fixture", worker: null, last_heartbeat_at: null, created_at: "", concluded_at: null,
      fact_ids: [], summary: "", graph_id: "main", to: null, attempts: 0 });
    const entry = projectEntry(graph, "main");
    assert.equal(entry.steps.length, OPEN_STEP_PREVIEW_LIMIT);
    assert.equal(entry.unclosed, count);
    assert.deepEqual(entry.open_step_index?.map(s => [s.id, s.version]), graph.steps.map(s => [s.id, s.version]));
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const page = queryMemory(graph, { ...entry.steps_preview!.query, kind: "steps", cursor });
      for (const row of page.items) {
        seen.add(row.id);
        assert.ok(JSON.parse(readMemoryRecord(graph, row.id).content!).description.includes(`不得遗漏的限制-${Number(row.id.slice(1))}`));
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(seen.size, count);
    const first = queryMemory(graph, { kind: "steps", status: "open", limit: 1 });
    assert.throws(() => queryMemory({ ...graph, revision: graph.revision + 1 }, { kind: "steps", status: "open", limit: 1, cursor: first.next_cursor! }), /snapshot/);
  } finally { store.close(); }
});
