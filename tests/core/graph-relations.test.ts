import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/core/src/store.js";
import { queryMemory, readMemoryRecord } from "../../packages/core/src/memory.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema, reviewSchema, resolveGraphRelations, walkRelations } from "../../packages/protocol/src/index.js";
import { Reports } from "../../packages/core/src/reports.js";
import { findingTrace } from "../../packages/core/src/report-material.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Causal graph", origin: "https://example.test", goal: "Trace observations" })).project.id;
  const step = store.manualStep(id, { from: ["origin"], description: "Observe first premise", creator: "human", claim: true });
  const proof = store.addEvidence(id, { title: "Direct proof", content: "Immutable response", encoding: "utf8", mime_type: "text/plain" });
  const fact = store.fact(id, step.id, { worker: "human", description: "First premise", evidence_ids: [proof.id] });
  const next = store.manualStep(id, { from: [fact.id], description: "Test the premise", creator: "human", claim: true });
  const output = store.fact(id, next.id, { worker: "human", description: "Second observation", evidence_ids: [] });
  const finding = store.submitStepFinding(id, next.id, "human", findingSchema.parse({ ...reportFields, title: "Conclusion", description: "Supported", from: [output.id], evidence_ids: [proof.id] }));
  return { store, id, step, proof, fact, next, output, finding };
}
const ids = (page: ReturnType<typeof queryMemory>) => page.items.map(item => item.id).sort();

test("typed causal queries follow the same multi-Step chain in both directions, retaining direct evidence", () => {
  const f = fixture();
  try {
    const graph = f.store.get(f.id);
    const page = queryMemory(graph, { related_to: f.fact.id, relation: "sources" });
    assert.deepEqual(ids(page), [f.proof.id, f.step.id].sort());
    assert.deepEqual(page.provenance, { producers: [{ step_id: f.step.id, inferred: false }], ambiguous: false });
    assert.deepEqual(page.relations!.map(edge => edge.kind).sort(), ["evidence_reference", "fact_production"]);
    assert.ok(ids(queryMemory(graph, { related_to: f.fact.id, depth: 2 })).includes("origin"));
    assert.ok(ids(queryMemory(graph, { related_to: f.output.id, depth: 3 })).includes(f.step.id));
    assert.ok(!ids(queryMemory(graph, { related_to: f.output.id, depth: 2 })).includes(f.proof.id), "Evidence beyond the requested depth needs another query");
    assert.ok(!ids(queryMemory(graph, { related_to: "origin", relation: "outputs", depth: 3 })).includes(f.output.id));
    assert.ok(ids(queryMemory(graph, { related_to: f.next.id, relation: "outputs" })).includes(f.output.id), "continue from the boundary Step");
    assert.ok(ids(queryMemory(graph, { related_to: f.step.id })).includes("origin"));
    assert.ok(ids(queryMemory(graph, { related_to: f.next.id, relation: "outputs" })).includes(f.finding.id));
    assert.ok(ids(queryMemory(graph, { related_to: f.finding.id })).includes(f.proof.id), "Finding directly references Evidence");
    const index = resolveGraphRelations(graph);
    for (const edge of index.relations) {
      assert.ok(queryMemory(graph, { related_to: edge.target }).items.some(item => item.id === edge.source), `${edge.source} → ${edge.target}: sources`);
      assert.ok(queryMemory(graph, { related_to: edge.source, relation: "outputs" }).items.some(item => item.id === edge.target), `${edge.source} → ${edge.target}: outputs`);
    }
    assert.equal(f.fact.step_id, f.step.id);
    assert.ok(f.fact.created_at);
    assert.equal(f.fact.run_id, undefined, "manual observation has no invented model Run");
    assert.equal(f.store.evidenceContent(f.id, f.proof.id).bytes.toString(), "Immutable response");
  } finally { f.store.close(); }
});

test("missing production metadata stays unknown without inferring Step ownership", () => {
  const f = fixture();
  try {
    const graph = f.store.get(f.id), fact = graph.facts.find(item => item.id === f.fact.id)!;
    delete fact.step_id; delete fact.run_id; delete fact.created_at;
    graph.steps[0].run_id = "latest-is-not-the-producer";
    graph.steps[1].fact_ids.push(fact.id);
    graph.steps[1].from.push("origin");
    graph.facts.push({ id: "old-orphan", description: "Imported observation", evidence_ids: [], graph_id: "old" });
    const before = JSON.stringify(graph);
    const index = resolveGraphRelations(graph), provenance = index.facts.get(fact.id)!;
    assert.equal(provenance.ambiguous, false);
    assert.deepEqual(provenance.producers, []);
    assert.deepEqual(readMemoryRecord(graph, fact.id).provenance, provenance);
    assert.ok(queryMemory(graph, { related_to: fact.id }).relations!.filter(edge => edge.kind === "fact_production").every(edge => edge.ambiguous && !edge.run_id));
    assert.deepEqual(index.facts.get("old-orphan"), { producers: [], ambiguous: false });
    assert.deepEqual(index.facts.get("origin"), { producers: [], ambiguous: false });
    assert.ok(ids(queryMemory(graph, { related_to: f.next.id })).includes("origin"), "multiple input Facts remain queryable");
    assert.equal(JSON.stringify(graph), before, "compatibility is read-only, not a synthetic migration");
  } finally { f.store.close(); }
});

test("causal pages keep stable filters, do not return the seed on cycles and carry review version edges", () => {
  const f = fixture();
  try {
    const graph = f.store.get(f.id);
    graph.steps[0].from.push(f.output.id); // malformed/legacy cycle
    graph.reviews.push({ id: "review-old", finding_id: f.finding.id, finding_version: 1, verdict: "needs_evidence", reason: "Previous version",
      evidence_ids: [], disputed_fact_ids: [], worker: "reviewer", created_at: "" });
    graph.findings[0].version = 2;
    const root = f.output.id, expected = queryMemory(graph, { related_to: root, depth: 3 });
    assert.ok(!ids(expected).includes(root));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = queryMemory(graph, { related_to: root, depth: 3, limit: 1, cursor });
      seen.push(...page.items.map(item => item.id));
      assert.ok(page.relations!.every(edge => page.items.some(item => item.id === edge.source)), "edges belong to this page");
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, expected.items.map(item => item.id));
    assert.equal(new Set(seen).size, seen.length);
    const first = queryMemory(graph, { related_to: root, depth: 3, limit: 1 });
    assert.throws(() => queryMemory(graph, { related_to: root, depth: 2, cursor: first.next_cursor! }), /snapshot\/query/);
    assert.throws(() => queryMemory({ ...graph, revision: graph.revision + 1 }, { related_to: root, depth: 3, cursor: first.next_cursor! }), /snapshot\/query/);
    const review = queryMemory(graph, { related_to: "review-old" });
    assert.deepEqual(review.relations, [{ source: f.finding.id, target: "review-old", kind: "review", finding_version: 1 }]);
    assert.equal(walkRelations(resolveGraphRelations(graph), [root], "sources").depths.has(root), false);
    assert.throws(() => queryMemory(graph, { related_to: root, depth: 4 }), /depth/);
  } finally { f.store.close(); }
});

test("Execute and Review carry the same production metadata and producer inputs without unrelated history", () => {
  const f = fixture();
  try {
    const graph = f.store.get(f.id);
    graph.steps[0].graph_id = "old";
    graph.facts.find(fact => fact.id === f.fact.id)!.graph_id = "old";
    const index = resolveGraphRelations(graph);
    for (const job of [
      { kind: "execute" as const, step_id: f.next.id },
      { kind: "review" as const, finding_id: f.finding.id },
    ]) {
      const view = memoryEntry(graph, { ...job, worker: "viewer", graph_id: "main", project_id: f.id }) as unknown as {
        facts: { id: string; provenance: unknown }[]; source_steps: { id: string; from: string[] }[];
      };
      for (const fact of view.facts) assert.deepEqual(fact.provenance, index.facts.get(fact.id));
      const expected = job.kind === "execute" ? f.step : f.next;
      assert.ok(view.source_steps.some(step => step.id === expected.id && step.from.includes(expected.from[0])));
    }
    assert.ok(ids(queryMemory(graph, { related_to: f.output.id, depth: 3 })).includes(f.step.id), "cross-graph predecessors are reachable");
  } finally { f.store.close(); }
});

test("reports freeze the complete causal ancestry and its Evidence", () => {
  const f = fixture();
  try {
    const ancestorProof = f.store.addEvidence(f.id, { title: "Earlier premise proof", content: "Earlier immutable response", encoding: "utf8", mime_type: "text/plain" });
    f.store.mutate(f.id, "fixture.ancestry", true, graph => {
      graph.facts.find(fact => fact.id === f.fact.id)!.evidence_ids.push(ancestorProof.id);
    });
    f.store.manualConclude(f.id, f.step.id, "human", "First response recorded");
    f.store.manualConclude(f.id, f.next.id, "human", "Second response recorded");
    const review = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    f.store.review(f.id, f.finding.id, reviewSchema.parse({ kind: "vulnerability", worker: review.worker, finding_version: 1, verdict: "pass",
      reason: "Evidence verified", evidence_ids: [f.proof.id], cvss: cvss.high }));
    const reports = new Reports(f.store), snapshot = reports.create(f.id), text = reports.markdown(snapshot);
    const trace = findingTrace(snapshot.material, f.finding.id);
    assert.deepEqual(trace.facts.map(fact => fact.id), ["origin", f.fact.id, f.output.id]);
    assert.deepEqual(trace.steps.map(step => step.id), [f.step.id, f.next.id]);
    assert.ok(snapshot.material.evidence.some(item => item.id === ancestorProof.id), "upstream proof is archived too");
    assert.ok(text.includes(`${f.step.id} → ${f.fact.id}（生产事实`));
    assert.ok(text.includes("First premise"));
    assert.ok(text.includes(ancestorProof.sha256));
    f.store.recordRead(f.id, f.fact.id);
    f.store.setCooldown(f.id, { node_id: f.fact.id, override: "cooled" });
    assert.equal(reports.list(f.id)[0].stale, false, "reading/cooling support is not a report material change");
    f.store.mutate(f.id, "fixture.contradiction", true, graph => {
      graph.facts.find(fact => fact.id === f.fact.id)!.status = "disputed";
    });
    assert.equal(reports.list(f.id)[0].stale, true, "upstream contradictions change report material");
    assert.equal(reports.markdown(reports.get(f.id, snapshot.id)), text, "the frozen trace cannot follow later graph changes");
  } finally { f.store.close(); }
});

test("reopening a Step keeps each observation's original Run across incremental/final writes and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-causal-runs-")), path = join(dir, "graph.db");
  let store = new Store(path);
  try {
    const id = store.create(createProjectSchema.parse({ title: "Run provenance", origin: "https://example.test", goal: "Assess" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Question", creator: "human" });
    const settle = () => {
      const planner = store.claim(id, "planner", 0)!;
      assert.equal(planner.kind, "decide");
      const graph = store.get(id);
      commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision }));
    };
    settle();
    const first = store.claim(id, "same-executor", 0)!;
    const incremental = store.fact(id, step.id, { worker: first.worker, description: "Incremental observation", evidence_ids: [] });
    store.execute(id, step.id, executeSchema.parse({ worker: first.worker, facts: ["Final observation"] }));
    store.closeStep(id, step.id, { worker: "human", reason: "Answered" });
    store.reopenStep(id, step.id, { worker: "human", reason: "New premise" });
    settle();
    const second = store.claim(id, "same-executor", 0)!;
    assert.notEqual(second.run_id, first.run_id);
    store.execute(id, step.id, executeSchema.parse({ worker: second.worker, facts: ["Reopened observation"] }));
    const facts = store.get(id).facts.filter(fact => fact.step_id === step.id);
    assert.deepEqual(facts.map(fact => fact.run_id), [first.run_id, first.run_id, second.run_id]);
    assert.equal(incremental.run_id, first.run_id);
    assert.ok(facts.every(fact => Number.isFinite(Date.parse(fact.created_at!))));
    store.close(); store = new Store(path);
    const graph = store.get(id), index = resolveGraphRelations(graph);
    for (const fact of facts) assert.equal(index.facts.get(fact.id)!.producers[0].run_id, fact.run_id);
    const support = memoryEntry(graph, { kind: "execute", project_id: id, graph_id: "main", worker: "viewer", step_id: step.id }) as unknown as { facts: { id: string; provenance: unknown }[] };
    assert.deepEqual(support.facts.find(fact => fact.id === incremental.id)!.provenance, index.facts.get(incremental.id));
    const changes = store.events(id).find(event => event.kind === "fact.observed")!.data.changes as { facts: { run_id: string }[] };
    assert.equal(changes.facts[0].run_id, first.run_id, "immutable events retain the original production identity");
    // Simulate a supported format-1 database written before provenance fields existed.
    store.mutate(id, "fixture.legacy", false, g => {
      const old = g.facts.find(fact => fact.id === incremental.id)!;
      delete old.step_id; delete old.run_id; delete old.created_at;
    });
    const persisted = JSON.stringify(store.get(id)), eventCount = store.events(id).length;
    store.close(); store = new Store(path);
    const legacyPage = readMemoryRecord(store.get(id), incremental.id);
    assert.deepEqual(legacyPage.provenance, { producers: [], ambiguous: false });
    assert.equal(JSON.parse(legacyPage.content!).run_id, undefined, "the newer Step Run is not backfilled onto a legacy Fact");
    assert.equal(JSON.stringify(store.get(id)), persisted);
    assert.equal(store.events(id).length, eventCount, "read compatibility does not create migration/observation events");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
