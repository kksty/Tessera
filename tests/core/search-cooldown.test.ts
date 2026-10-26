import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { memoryEntry, queryMemory } from "../../packages/core/src/memory.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-search-"));
  const file = join(dir, "graph.db");
  const store = new Store(file);
  const id = store.create(
    createProjectSchema.parse({ title: "Search", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  return {
    dir,
    file,
    store,
    id,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("full-text search covers node text and evidence bodies, including Chinese and short keywords", () => {
  const f = fixture();
  try {
    const evidence = f.store.addEvidence(f.id, {
      title: "会话响应",
      content: "legacy-cookie 必须保留，否则会话失效。",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    const binary = f.store.addEvidence(f.id, {
      title: "截图",
      content: Buffer.from([0, 1, 2, 3, ...Buffer.from("binneedle")]).toString("base64"),
      encoding: "base64",
      mime_type: "image/png",
    });
    const step = f.store.manualStep(f.id, {
      from: ["origin"],
      description: "检查会话条件",
      creator: "human",
      claim: true,
    });
    f.store.manualConclude(f.id, step.id, "human", "会话依赖 legacy-cookie。后续细节不应命中。");
    // Long keyword: trigram MATCH, finds the fact's conclusion and the evidence body.
    const hit = f.store.searchMemory(f.id, "legacy-cookie");
    assert.ok(hit.ids.length >= 2);
    assert.ok(f.store.searchMemory(f.id, "必须保留").ids.includes(evidence.id));
    // Short keyword: LIKE fallback.
    assert.ok(f.store.searchMemory(f.id, "会话").ids.includes(evidence.id));
    // The binary evidence keeps metadata only; its body is not indexed.
    assert.equal(f.store.get(f.id).evidence.find((e) => e.id === binary.id)!.indexed, false);
    assert.ok(!f.store.searchMemory(f.id, "binneedle").ids.includes(binary.id), "binary bodies are not indexed");
    // Kind filter and no match.
    assert.deepEqual(f.store.searchMemory(f.id, "legacy-cookie", "evidence").ids, [evidence.id]);
    assert.deepEqual(f.store.searchMemory(f.id, "不存在的关键词"), { ids: [], total: 0 });
    // Search never warms a node by itself.
    assert.equal(f.store.get(f.id).facts.find((x) => x.id !== "origin")!.last_read_round, undefined);
  } finally {
    f.close();
  }
});

test("the FTS index survives restart and rebuilds when rows are missing", () => {
  const f = fixture();
  try {
    const step = f.store.manualStep(f.id, {
      from: ["origin"],
      description: "Unique needle phrase",
      creator: "human",
      claim: true,
    });
    f.store.manualConclude(f.id, step.id, "human", "needle observed");
    const fact = f.store.get(f.id).facts.at(-1)!;
    assert.ok(f.store.searchMemory(f.id, "needle").ids.includes(fact.id));
    f.store.close();
    const reopened = new Store(f.file);
    try {
      assert.ok(reopened.searchMemory(f.id, "needle").ids.includes(fact.id), "rows persist");
      reopened.db.exec("DELETE FROM memory_fts");
      reopened.close();
      const rebuilt = new Store(f.file);
      try {
        assert.ok(rebuilt.searchMemory(f.id, "needle").ids.includes(fact.id), "a missing index is rebuilt at startup");
      } finally {
        rebuilt.close();
      }
    } catch (error) {
      if (f.store) f.store.close();
      throw error;
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

function cooldownFixture() {
  const f = fixture();
  // A concluded Step, a referenced Fact, and its Evidence. The open Step keeps work visible.
  const first = f.store.manualStep(f.id, {
    from: ["origin"],
    description: "Collect evidence",
    creator: "human",
    claim: true,
  });
  const evidence = f.store.addEvidence(f.id, {
    title: "原始输出",
    content: "cold evidence body",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  f.store.mutate(f.id, "fixture.fact", true, (g) => {
    const step = g.steps.find((s) => s.id === first.id)!;
    step.fact_ids.push("f777");
    g.facts.push({
      id: "f777",
      description: "Referenced fact",
      conclusion: "A referenced fact",
      status: "observed",
      graph_id: "main",
      evidence_ids: [evidence.id],
    });
  });
  f.store.mutate(f.id, "fixture.reference", false, (g) => {
    // A real write would warm these; simulate the reference explicitly without inventing a second fact id.
    g.evidence.find((e) => e.id === evidence.id)!.last_referenced_round = 0;
  });
  f.store.manualConclude(f.id, first.id, "human", "Evidence captured");
  f.store.mutate(f.id, "fixture.unrelated", false, (g) => {
    g.facts.push({
      id: "f779",
      description: "Unrelated historical fact",
      conclusion: "Unrelated",
      status: "observed",
      graph_id: "main",
      evidence_ids: [],
    });
  });
  const open = f.store.manualStep(f.id, { from: ["f777"], description: "Open follow-up", creator: "human" });
  return { ...f, evidence, first, open };
}

test("hot budget keeps open work and recent facts; closed Steps and Evidence are not cold", () => {
  const f = cooldownFixture();
  try {
    const coldIds = () => f.store.peekCold(f.id, { limit: 200 }).items.map((item) => item.id);
    const entry = () =>
      memoryEntry(f.store.get(f.id), { kind: "decide", project_id: f.id, graph_id: "main", worker: "w" });
    // Default 200: the facts fit; a closed Step and Evidence are not entry material and not cold nodes.
    assert.ok(!coldIds().includes(f.open.id), "open Steps never cool");
    assert.ok(!coldIds().includes(f.first.id), "a concluded Step is not cold");
    assert.ok(!coldIds().includes(f.evidence.id), "Evidence is not cold");
    assert.equal(entry().cold.count, 0);
    assert.equal(entry().evidence.total, 1, "Evidence still has its own total");

    assert.ok(!coldIds().includes("f777"), "with the default budget the open premise stays visible");
    // A budget of one keeps only the most recent candidate: inputs of other open
    // Steps are not mandatory any more (the entry carries their ids instead).
    f.store.setCooldown(f.id, { hot_limit: 1 });
    assert.ok(coldIds().includes("f779"), "over budget, the older fact cools");
    assert.equal(entry().cold.count, 2);
    // Reading warms the node; query lists do not.
    f.store.searchMemory(f.id, "Referenced fact");
    assert.ok(coldIds().includes("f779"), "a search hit does not warm");
    f.store.mutate(f.id, "fixture.clock", false, (g) => {
      g.project.decision_round = 1;
    });
    f.store.recordRead(f.id, "f779");
    assert.ok(!coldIds().includes("f779"), "a real read warms (and pushes out the older fact)");
    assert.ok(coldIds().includes("f778"));
    // Manual overrides and the off switch.
    f.store.setCooldown(f.id, { node_id: "f778", override: "pinned" });
    assert.ok(!coldIds().includes("f778"), "pinned never cools");
    f.store.setCooldown(f.id, { node_id: "f778", override: "auto" });
    assert.ok(coldIds().includes("f778"));
    f.store.setCooldown(f.id, { node_id: f.evidence.id, override: "cooled" });
    assert.ok(!coldIds().includes(f.evidence.id), "Evidence never enters the cold pool");
    f.store.setCooldown(f.id, { node_id: f.evidence.id, override: "auto" });
    f.store.setCooldown(f.id, { hot_limit: 0 });
    assert.equal(f.store.peekCold(f.id, {}).disabled, true);
    assert.equal(entry().cold.count, 0);
    assert.deepEqual(entry().cold.sample, []);
  } finally {
    f.close();
  }
});

test("query status=cold/hot only covers Facts/Findings; Evidence stays reachable by kind", () => {
  const f = cooldownFixture();
  try {
    f.store.setCooldown(f.id, { hot_limit: 1 });
    const graph = f.store.get(f.id);
    assert.deepEqual(
      queryMemory(graph, { status: "cold" }).items.map((item) => item.id),
      ["f778", "f779"],
    );
    assert.equal(queryMemory(graph, { kind: "evidence", status: "cold" }).total, 0, "Evidence is never cold");
    assert.equal(queryMemory(graph, { kind: "evidence", status: "hot" }).total, 0, "Evidence is not hot either");
    assert.equal(queryMemory(graph, { kind: "steps", status: "cold" }).total, 0, "closed Steps are never cold");
    assert.equal(
      queryMemory(graph, { kind: "evidence" }).items[0].id,
      f.evidence.id,
      "Evidence is still found by kind",
    );
  } finally {
    f.close();
  }
});

test("peek pages are unbiased, repeat-free and reproducible, and the pool revision changes with membership", () => {
  const f = fixture();
  try {
    // Ten referenced facts, five hot and five cold at a hot limit of five.
    f.store.mutate(f.id, "fixture.pool", false, (g) => {
      g.project.decision_round = 30;
      g.project.hot_limit = 5;
      for (let i = 0; i < 10; i++)
        g.facts.push({
          id: `f9${i}`,
          description: `Pool fact ${i}`,
          conclusion: `Pool ${i}`,
          status: "observed",
          graph_id: "main",
          evidence_ids: [],
          last_referenced_round: 0,
        });
    });
    const seen: string[] = [];
    let cursor: string | undefined, page;
    do {
      page = f.store.peekCold(f.id, { cursor, limit: 3 });
      assert.ok(page.items.length <= 3);
      assert.deepEqual(
        page.items.map((i) => i.id),
        [...new Set(page.items.map((i) => i.id))],
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen).size, 5, "every cold node is returned exactly once");
    // Same seed and pool revision reproduce the same order.
    const first = f.store.peekCold(f.id, { limit: 5 });
    const again = f.store.peekCold(f.id, { limit: 5 });
    assert.deepEqual(
      again.items.map((i) => i.id),
      first.items.map((i) => i.id),
    );
    assert.equal(again.seed, first.seed);
    assert.equal(again.pool_revision, first.pool_revision);
    assert.equal(again.algorithm, "mulberry32-fisher-yates-v1");
    // Membership change bumps the pool revision and starts a fresh shuffle.
    f.store.mutate(f.id, "fixture.pool2", false, (g) => {
      for (let i = 0; i < 5; i++)
        g.facts.push({
          id: `f8${i}`,
          description: `New cold fact ${i}`,
          conclusion: `New ${i}`,
          status: "observed",
          graph_id: "main",
          evidence_ids: [],
          last_referenced_round: 0,
        });
    });
    const changed = f.store.peekCold(f.id, {});
    assert.ok(changed.pool_revision > first.pool_revision);
    assert.equal(f.store.get(f.id).project.pool_revision, changed.pool_revision);
    assert.equal(changed.total, 10);
  } finally {
    f.close();
  }
});
