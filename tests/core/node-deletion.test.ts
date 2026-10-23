import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema, executeSchema, decideSchema, reviewSchema, submitDecisionsSchema, deletionPreviewSchema, activeGraph, resolveGraphRelations } from "../../packages/protocol/src/index.js";
import { memoryEntry, queryMemory, readMemoryRecord } from "../../packages/core/src/memory.js";
import { Reports } from "../../packages/core/src/reports.js";
import { paragraph } from "../../packages/core/src/report-text.js";
import { stepAssets } from "../../packages/protocol/src/asset-scope.js";
import { scoreCvss } from "../../packages/core/src/cvss.js";
import { cvss, withImpactEvidence } from "../fixtures/cvss.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-node-deletion-")), file = join(dir, "graph.db");
  const store = new Store(file), id = store.create(createProjectSchema.parse({ title: "Autonomous deletion", origin: "https://example.test", goal: "Assess" })).project.id;
  const shared = store.addEvidence(id, { title: "Shared proof", content: "shared raw proof", encoding: "utf8", mime_type: "text/plain" });
  const sole = store.addEvidence(id, { title: "DELETED_BODY_sole_proof", content: "DELETED_BODY_sole_proof", encoding: "utf8", mime_type: "text/plain" });
  const first = store.manualStep(id, { from: ["origin"], description: "First branch", creator: "human", claim: true });
  const fact = store.fact(id, first.id, { worker: "human", description: "DELETED_BODY_fact", evidence_ids: [shared.id, sole.id] });
  store.execute(id, first.id, executeSchema.parse({ worker: "human", summary: "DELETED_BODY_summary" }));
  store.closeStep(id, first.id, { worker: "human", reason: "Answered" });
  const second = store.manualStep(id, { from: [fact.id], description: "Consumer branch", creator: "human", claim: true });
  const output = store.fact(id, second.id, { worker: "human", description: "Consumer output", evidence_ids: [shared.id] });
  const finding = store.submitStepFinding(id, second.id, "human", findingSchema.parse({ title: "Retained conclusion", description: "Valid direct proof", from: [fact.id], evidence_ids: [shared.id] }));
  store.execute(id, second.id, executeSchema.parse({ worker: "human", summary: "Consumer finished" }));
  store.closeStep(id, second.id, { worker: "human", reason: "Answered" });
  store.mutate(id, "fixture.review", false, graph => {
    Object.assign(graph.findings[0], { review_status: "pass", reviewed_version: 1, status: "confirmed", kind: "vulnerability", severity: "high", cvss: scoreCvss(withImpactEvidence(cvss.high, [shared.id])) });
    graph.goals.push({ id: "g001", description: "Model subgoal", state: "active", graph_id: "main" });
    graph.bookmarks = [{ id: "bookmark-deleted", node_id: fact.id, reason: "DELETED_BODY_bookmark", revisit_when: "DELETED_BODY_bookmark",
      version: 1, created_at: "", updated_at: "", updated_by: "fixture", run_id: "historical" }];
  });
  return { dir, file, store, id, first, fact, second, output, finding, shared, sole,
    close() { this.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function decision(f: ReturnType<typeof fixture>, payload: Record<string, unknown>, key = "delete") {
  const job = f.store.claim(f.id, "decider", 0)!;
  assert.equal(job.kind, "decide");
  const graph = f.store.get(f.id);
  const body = submitDecisionsSchema.parse({ submission_id: key, worker: job.worker, revision: graph.revision,
    observation_revision: graph.observation_revision, planning_revision: graph.planning_revision, ...payload });
  return { job, body, result: f.store.submitDecisions(f.id, body, job.run_id) };
}

test("deletion preview is read-only, exposes shared descendants and predicts the exact cancellation and settlement", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.shared", true, graph => {
      graph.facts.push({ id: "f900", description: "Independent retained premise", evidence_ids: [], graph_id: "main" });
      graph.steps[1].from.push("f900");
      Object.assign(graph.findings[0], { review_status: "pending", reviewed_version: 0, status: "candidate" });
    });
    const live = f.store.manualStep(f.id, { from: [f.fact.id, "f900"], description: "Live shared consumer", creator: "human" });
    const executor = f.store.claim(f.id, "executor", deferDecideMs)!;
    const reviewer = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(executor.step_id, live.id); assert.equal(reviewer.kind, "review");
    const inputs = deletionPreviewSchema.parse({ delete_nodes: [{ id: f.fact.id, reason: "Abandon reachable branch", cascade: "downstream" }] }).delete_nodes;
    const before = f.store.get(f.id), events = f.store.events(f.id), runs = f.store.runs(f.id);
    const preview = f.store.previewDeletions(f.id, inputs);
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.shared_descendants, [f.second.id, live.id].map(id => ({ id, retained_dependencies: ["f900"] })));
    assert.deepEqual(preview.cancelled_runs, [executor.run_id!, reviewer.run_id!].sort());
    assert.equal(preview.effects.descendants_with_other_sources_are_deleted, true);
    assert.equal(preview.effects.cancelled_external_requests_may_already_have_executed, true);
    assert.deepEqual(f.store.get(f.id), before);
    assert.deepEqual(f.store.events(f.id), events);
    assert.deepEqual(f.store.runs(f.id), runs);
    const job = f.store.claim(f.id, "decider", 0)!, graph = f.store.get(f.id);
    const body = submitDecisionsSchema.parse({ submission_id: "previewed-delete", worker: job.worker,
      revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      delete_nodes: inputs, deletion_preview_hash: preview.impact_hash });
    const result = f.store.submitDecisions(f.id, body, job.run_id);
    assert.equal(result.settle.ok, true);
    for (const key of ["deleted", "affected", "cancelled_runs"] as const) assert.deepEqual(result.settle[key], preview[key]);
    assert.equal(f.store.get(f.id).facts.find(fact => fact.id === "f900")!.deleted, undefined);
    assert.deepEqual(f.store.submitDecisions(f.id, body, job.run_id), result);
    assert.throws(() => f.store.submitDecisions(f.id, { ...body, deletion_preview_hash: "0".repeat(64) }, job.run_id), /different content/);
  } finally { f.close(); }
});

test("changed impact requires a new preview even with a fresh graph snapshot; an independent plan survives", () => {
  const f = fixture();
  try {
    const inputs = deletionPreviewSchema.parse({ delete_nodes: [{ id: f.fact.id, reason: "Remove branch", cascade: "downstream" }] }).delete_nodes;
    const old = f.store.previewDeletions(f.id, inputs);
    const extra = f.store.manualStep(f.id, { from: [f.fact.id], description: "Newly connected consumer", creator: "human" });
    const job = f.store.claim(f.id, "decider", 0)!, graph = f.store.get(f.id);
    const body = submitDecisionsSchema.parse({ submission_id: "stale-preview", worker: job.worker,
      revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      steps: [{ from: ["origin"], description: "Keep this independent plan" }],
      delete_nodes: inputs, deletion_preview_hash: old.impact_hash });
    const result = f.store.submitDecisions(f.id, body, job.run_id);
    assert.equal(result.settle.ok, false);
    assert.ok(result.settle.conflicts.some(conflict => /impact changed/.test(conflict.reason)));
    assert.ok(f.store.get(f.id).facts.every(fact => !fact.deleted));
    assert.ok(f.store.get(f.id).steps.some(step => step.description === "Keep this independent plan"));
    const fresh = f.store.previewDeletions(f.id, inputs), read = f.store.get(f.id);
    assert.ok(fresh.deleted.includes(extra.id));
    assert.notEqual(fresh.impact_hash, old.impact_hash);
    assert.equal(f.store.submitDecisions(f.id, { ...body, submission_id: "fresh-preview", plan_id: result.plan_id, steps: [],
      revision: read.revision, observation_revision: read.observation_revision, planning_revision: read.planning_revision, deletion_preview_hash: fresh.impact_hash }, job.run_id).settle.ok, true);
  } finally { f.close(); }
});

test("none preview retains dependent work and protected or repeated roots return conflicts without writes", () => {
  const f = fixture();
  try {
    const before = f.store.get(f.id);
    const preview = f.store.previewDeletions(f.id, deletionPreviewSchema.parse({ delete_nodes: [{ id: f.fact.id, reason: "Only this node" }] }).delete_nodes);
    assert.deepEqual(preview.deleted, [f.fact.id]);
    assert.ok(preview.affected.includes(f.second.id));
    assert.deepEqual(preview.shared_descendants, []);
    assert.deepEqual(preview.cancelled_runs, []);
    const invalid = f.store.previewDeletions(f.id, deletionPreviewSchema.parse({ delete_nodes:
      ["origin", f.fact.id, f.fact.id].map(id => ({ id, reason: "Invalid batch" })) }).delete_nodes);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.conflicts.length, 2);
    assert.deepEqual(f.store.get(f.id), before);
  } finally { f.close(); }
});

test("Decide deletes a referenced Fact without Hint/approval, retaining unrelated work, pass and raw history", () => {
  const f = fixture();
  try {
    const { result, body, job } = decision(f, { delete_nodes: [{ id: f.fact.id, reason: "No longer useful" }] });
    assert.equal(result.settle.ok, true);
    assert.deepEqual(result.settle.deleted, [f.fact.id]);
    const graph = f.store.get(f.id), removed = graph.facts.find(fact => fact.id === f.fact.id)!;
    assert.equal(removed.description, "DELETED_BODY_fact");
    assert.equal(removed.deleted?.run_id, job.run_id);
    assert.equal(removed.deleted?.submission_id, body.submission_id);
    assert.equal(graph.findings[0].version, 1);
    assert.equal(graph.findings[0].review_status, "pass");
    assert.equal(graph.steps[1].deleted, undefined);
    const view = activeGraph(graph);
    assert.ok(!view.facts.some(fact => fact.id === f.fact.id));
    assert.equal(view.bookmarks!.length, 0);
    assert.ok(!JSON.stringify(memoryEntry(graph, { kind: "decide", project_id: f.id, graph_id: "main", worker: "viewer" })).includes("DELETED_BODY"));
    assert.equal(queryMemory(graph, { keyword: "DELETED_BODY" }).items.length, 0);
    assert.equal(f.store.searchMemory(f.id, "DELETED_BODY").ids.length, 0);
    assert.ok(view.evidence.some(e => e.id === f.shared.id));
    assert.ok(!view.evidence.some(e => e.id === f.sole.id));
    assert.equal(f.store.evidenceContent(f.id, f.sole.id).bytes.toString(), "DELETED_BODY_sole_proof");
    assert.ok(resolveGraphRelations(view).relations.some(edge => edge.source === f.fact.id && edge.target === f.second.id && edge.source_deleted));
    assert.deepEqual(f.store.submitDecisions(f.id, body, job.run_id), result, "accepted deletion remains replayable after lease ends");
    assert.throws(() => f.store.submitDecisions(f.id, { ...body, delete_nodes: [{ id: f.fact.id, reason: "different", cascade: "none" }] }, job.run_id), /different content/);
  } finally { f.close(); }
});

test("explicit downstream cascade follows causal edges and model subgoals, never shared Evidence or assets", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.independent", true, graph => {
      graph.facts.push({ id: "f900", description: "Independent shared proof", graph_id: "main", evidence_ids: [f.shared.id], asset_id: "a001" });
    });
    const { result } = decision(f, { delete_nodes: [{ id: f.fact.id, reason: "Abandon this branch", cascade: "downstream" }] });
    assert.equal(result.settle.ok, true);
    assert.deepEqual(result.settle.deleted, [f.fact.id, f.output.id, f.second.id, f.finding.id].sort());
    assert.ok(activeGraph(f.store.get(f.id)).facts.some(fact => fact.id === "f900"));
    assert.ok(!f.store.get(f.id).steps[0].deleted, "upstream producer survives");
    assert.equal(f.store.get(f.id).assets[0].approval, "approved");
    assert.equal(f.store.overview().totals.confirmed, 0);
  } finally { f.close(); }
});

test("deletion conflicts leave the whole settlement untouched and retain an independently committed plan", () => {
  const f = fixture();
  try {
    const { result } = decision(f, { steps: [{ from: ["origin"], description: "Independent new question" }],
      delete_nodes: [{ id: f.second.id, reason: "Remove" }], updates: [{ id: f.second.id, expected_version: f.store.get(f.id).steps[1].version, priority: 9 }] });
    assert.equal(result.settle.ok, false);
    assert.ok(result.settle.conflicts.some(conflict => conflict.kind === "delete"));
    assert.equal(f.store.get(f.id).steps[1].deleted, undefined);
    assert.ok(f.store.get(f.id).steps.some(step => step.description === "Independent new question"));
  } finally { f.close(); }
});

test("protected inputs, stale snapshots and plans depending on deleted nodes are rejected", () => {
  for (const target of ["origin", "goal", "a001", "e001", "unknown"]) {
    const f = fixture();
    try {
      const { result } = decision(f, { delete_nodes: [{ id: target, reason: "Remove" }] });
      assert.equal(result.settle.ok, false, target);
      assert.ok(f.store.get(f.id).facts.every(fact => !fact.deleted));
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    assert.throws(() => decision(f, { delete_nodes: [{ id: f.fact.id, reason: "Remove" }],
      steps: [{ from: [f.fact.id], description: "Invalid dependency" }] }), /delet/i);
    assert.ok(!f.store.get(f.id).steps.some(step => step.description === "Invalid dependency"));
  } finally { f.close(); }
});

test("all four node kinds can be removed in one settlement, with history, IDs and FTS stable across restart", () => {
  const f = fixture();
  try {
    const { result } = decision(f, { delete_nodes: [f.fact.id, f.first.id, f.finding.id, "g001"].map(id => ({ id, reason: "Retire work memory" })) });
    assert.equal(result.settle.ok, true);
    assert.equal(result.settle.deleted.length, 4);
    assert.equal(f.store.list()[0].fact_count, 2);
    assert.equal(f.store.allFindings().length, 0);
    assert.equal(readMemoryRecord(f.store.get(f.id), f.fact.id).deleted, true);
    assert.ok(!readMemoryRecord(f.store.get(f.id), f.fact.id).content!.includes("DELETED_BODY_fact"));
    const original = readMemoryRecord(f.store.get(f.id), f.fact.id, 0, 12000, undefined, true);
    assert.ok(original.content!.includes("DELETED_BODY_fact"));
    assert.equal(original.deletion?.reason, "Retire work memory");
    assert.ok(queryMemory(f.store.get(f.id), { history: true, keyword: "DELETED_BODY_fact" }).items.some(item => item.id === f.fact.id));
    f.store.search.remove(f.id); // force index reconstruction on restart
    const revision = f.store.get(f.id).revision;
    f.store.close(); f.store = new Store(f.file);
    assert.equal(f.store.get(f.id).node_lifecycle_version, 1);
    assert.equal(f.store.get(f.id).revision, revision);
    assert.equal(f.store.searchMemory(f.id, "DELETED_BODY").ids.length, 0);
    const next = f.store.manualStep(f.id, { from: ["origin"], description: "First branch", creator: "human", claim: true });
    assert.notEqual(next.id, f.first.id);
    assert.ok(Number(next.id.slice(1)) > Number(f.second.id.slice(1)));
    const fact = f.store.fact(f.id, next.id, { worker: "human", description: "New observation", evidence_ids: [] });
    assert.ok(Number(fact.id.slice(1)) > Number(f.output.id.slice(1)));
    assert.throws(() => f.store.updateStep(f.id, f.first.id, { priority: 9 }), /deleted/i);
    assert.throws(() => f.store.reopenStep(f.id, f.first.id, { worker: "human", reason: "Restore" }), /deleted/i);
    assert.throws(() => f.store.reviseFinding(f.id, f.finding.id, { title: "Restore" }), /deleted/i);
    assert.throws(() => f.store.editGoal(f.id, "g001", "Restore"), /deleted/i);
    assert.throws(() => f.store.manualStep(f.id, { from: [f.fact.id], description: "Deleted premise", creator: "human" }), /Invalid source/);
  } finally { f.close(); }
});

test("single Fact deletion preserves producer/consumer Runs; explicit Step/Finding deletion ends only their leases", () => {
  const f = fixture();
  try {
    const live = f.store.manualStep(f.id, { from: [f.fact.id], description: "Live consumer", creator: "human" });
    const executor = f.store.claim(f.id, "executor", deferDecideMs)!;
    assert.equal(executor.kind, "execute");
    const streamed = f.store.fact(f.id, live.id, { worker: executor.worker, description: "Streaming output", evidence_ids: [] });
    f.store.mutate(f.id, "fixture.review.pending", true, graph => {
      Object.assign(graph.findings[0], { review_status: "pending", reviewed_version: 0, status: "candidate" });
    });
    const reviewer = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    assert.equal(reviewer.kind, "review");
    const first = decision(f, { delete_nodes: [f.fact.id, streamed.id].map(id => ({ id, reason: "Forget old output" })) });
    assert.equal(first.result.settle.ok, true);
    assert.deepEqual(first.result.settle.cancelled_runs, []);
    assert.throws(() => f.store.review(f.id, f.finding.id, reviewSchema.parse({ worker: reviewer.worker, finding_version: 1,
      verdict: "rejected", reason: "Old context cannot edit a removed source", disputed_fact_ids: [f.fact.id] })), /Source Fact deleted/);
    for (const job of [executor, reviewer]) assert.equal(f.store.execution.get(f.id, job.run_id!)!.status, "running");
    assert.deepEqual(stepAssets(f.store.view(f.id), f.store.view(f.id).steps.find(step => step.id === live.id)!), ["a001"]);
    const fresh = f.store.fact(f.id, live.id, { worker: executor.worker, description: "Independent new observation after deletion", evidence_ids: [] });
    assert.notEqual(fresh.id, streamed.id);
    const retained = f.store.submitStepFinding(f.id, live.id, executor.worker, findingSchema.parse({
      title: "Keep the new conclusion", description: "New independent output", from: [fresh.id] }));
    const second = decision(f, { delete_nodes: [live.id, f.finding.id].map(id => ({ id, reason: "End those tasks" })) }, "cancel-tasks");
    assert.equal(second.result.settle.ok, true);
    assert.deepEqual(second.result.settle.cancelled_runs, [executor.run_id!, reviewer.run_id!].sort());
    for (const job of [executor, reviewer]) {
      assert.equal(f.store.execution.get(f.id, job.run_id!)!.status, "cancelled");
      assert.throws(() => f.store.heartbeat(f.id, job), /lease lost/i);
      assert.throws(() => f.store.validateSubmission(f.id, job.run_id!, { worker: job.worker }), /active Run/);
    }
    assert.throws(() => f.store.fact(f.id, live.id, { worker: executor.worker, description: "Late write", evidence_ids: [] }), /deleted/i);
    assert.equal(f.store.get(f.id).facts.find(fact => fact.id === fresh.id)!.deleted, undefined, "deleting only the Step does not delete its output");
    assert.equal(f.store.get(f.id).findings.find(finding => finding.id === retained.id)!.deleted, undefined);
  } finally { f.close(); }
});

test("a stale deletion returns a refresh conflict without acknowledging unread observations or rolling back its plan", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "decider", 0)!, read = f.store.get(f.id);
    f.store.hint(f.id, "New directive while Decide was running");
    const current = f.store.get(f.id);
    const body = submitDecisionsSchema.parse({ worker: job.worker, submission_id: "stale-delete", revision: read.revision,
      observation_revision: read.observation_revision, planning_revision: read.planning_revision, steps: [{ from: ["origin"], description: "Independent plan" }],
      delete_nodes: [{ id: f.fact.id, reason: "Remove" }] });
    const result = f.store.submitDecisions(f.id, body, job.run_id);
    assert.equal(result.settle.ok, false);
    assert.ok(result.settle.conflicts.some(conflict => conflict.kind === "snapshot"));
    assert.ok(f.store.get(f.id).steps.some(step => step.description === "Independent plan"));
    assert.equal(f.store.get(f.id).facts[1].deleted, undefined);
    assert.equal(f.store.get(f.id).decided_revision, current.decided_revision);
    const refreshed = f.store.get(f.id);
    const retry = submitDecisionsSchema.parse({ ...body, submission_id: "refreshed-delete", plan_id: result.plan_id, steps: [],
      revision: refreshed.revision, observation_revision: refreshed.observation_revision, planning_revision: refreshed.planning_revision });
    assert.equal(f.store.submitDecisions(f.id, retry, job.run_id).settle.ok, true);
    assert.equal(f.store.get(f.id).decided_revision, refreshed.observation_revision);
  } finally { f.close(); }
});

test("model subgoal cascades are cycle-safe and same-batch completion uses the graph after deletion", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.goal", true, graph => {
      graph.steps[0].goal_id = "g001";
      graph.steps[0].from.push(f.output.id); // legacy cycle, never cascade into origin
    });
    const { result } = decision(f, { delete_nodes: [{ id: "g001", reason: "Abandon the branch", cascade: "downstream" }],
      complete: { from: ["origin"], description: "Assessment stopped after abandoning this branch" } });
    assert.equal(result.settle.ok, true);
    assert.ok(result.settle.deleted.includes("g001"));
    for (const id of [f.first.id, f.second.id, f.fact.id, f.output.id, f.finding.id]) assert.ok(result.settle.deleted.includes(id));
    assert.equal(f.store.get(f.id).project.status, "completed");
    assert.equal(f.store.get(f.id).facts[0].id, "origin");
    assert.equal(f.store.get(f.id).facts[0].deleted, undefined);
  } finally { f.close(); }
});

test("deleting a Fact changes trace material without invalidating a retained Finding pass; old reports stay frozen", () => {
  const f = fixture();
  try {
    const reports = new Reports(f.store), before = reports.create(f.id), markdown = reports.markdown(before);
    assert.ok(markdown.includes(paragraph("DELETED_BODY_fact")));
    decision(f, { delete_nodes: [{ id: f.fact.id, reason: "Remove work memory" }] });
    assert.equal(f.store.overview().totals.confirmed, 1);
    assert.equal(reports.list(f.id).find(report => report.id === before.id)!.stale, true);
    assert.equal(reports.markdown(reports.get(f.id, before.id)), markdown);
    const after = reports.create(f.id), current = reports.markdown(after);
    assert.equal(after.material.findings.length, 1);
    assert.ok(!current.includes("DELETED_BODY"));
    assert.ok(current.includes("来源节点已删除"));
    assert.equal(after.material.findings[0].version, 1);
    const graph = f.store.get(f.id), changes = f.store.memoryChanges(f.id, { after_revision: 0, through_revision: graph.revision, limit: 100 });
    assert.ok(!JSON.stringify(changes).includes("DELETED_BODY"));
    assert.ok(changes.items.some(item => item.id === f.fact.id && item.deleted));
    const related = queryMemory(graph, { related_to: f.second.id, relation: "sources" });
    assert.ok(related.items.some(item => item.id === f.fact.id && item.status === "deleted"));
    assert.equal(graph.findings[0].review_status, "pass");
  } finally { f.close(); }
});

test("an indexing failure rolls back deletion, events, Run cancellation and receipt while the plan remains committed", () => {
  const f = fixture();
  try {
    const live = f.store.manualStep(f.id, { from: ["origin"], description: "Live task", creator: "human" });
    const executor = f.store.claim(f.id, "executor", deferDecideMs)!;
    const job = f.store.claim(f.id, "decider", 0)!, read = f.store.get(f.id);
    const body = submitDecisionsSchema.parse({ submission_id: "rollback", worker: job.worker, revision: read.revision,
      observation_revision: read.observation_revision, planning_revision: read.planning_revision, steps: [{ from: ["origin"], description: "Keep the independent plan" }],
      delete_nodes: [{ id: live.id, reason: "Stop" }] });
    const rebuild = f.store.search.rebuild.bind(f.store.search);
    f.store.search.rebuild = () => { throw new Error("synthetic FTS failure"); };
    assert.throws(() => f.store.submitDecisions(f.id, body, job.run_id), /synthetic FTS failure/);
    f.store.search.rebuild = rebuild;
    assert.equal(f.store.execution.get(f.id, executor.run_id!)!.status, "running");
    assert.equal(f.store.get(f.id).steps.find(step => step.id === live.id)!.deleted, undefined);
    assert.ok(f.store.get(f.id).steps.some(step => step.description === "Keep the independent plan"));
    assert.equal(f.store.submitDecisions(f.id, body, job.run_id).settle.ok, true);
  } finally { f.close(); }
});

test("canonical production hides deleted output summaries even when the legacy reverse index is absent", () => {
  const f = fixture();
  try {
    f.store.mutate(f.id, "fixture.legacy-index", false, graph => { graph.steps[0].fact_ids = []; });
    const { result } = decision(f, { delete_nodes: [{ id: f.fact.id, reason: "Retire canonical output" }] });
    assert.equal(result.settle.ok, true);
    assert.ok(!JSON.stringify(activeGraph(f.store.get(f.id))).includes("DELETED_BODY"));
    assert.deepEqual(activeGraph(f.store.get(f.id)).steps[0].deleted_output_ids, [f.fact.id]);
    assert.equal(f.store.searchMemory(f.id, "DELETED_BODY").ids.length, 0);
  } finally { f.close(); }
});

test("retained Facts carry deleted producer markers in all three task views", () => {
  const f = fixture();
  try {
    assert.equal(decision(f, { delete_nodes: [{ id: f.first.id, reason: "Remove producer, retain observations" }] }).result.settle.ok, true);
    const graph = f.store.get(f.id);
    for (const job of [
      { kind: "decide" as const, project_id: f.id, graph_id: "main", worker: "viewer" },
      { kind: "execute" as const, project_id: f.id, graph_id: "main", worker: "viewer", step_id: f.second.id },
      { kind: "review" as const, project_id: f.id, graph_id: "main", worker: "viewer", finding_id: f.finding.id },
    ]) assert.ok(memoryEntry(graph, job).deleted_sources.some(ref => ref.id === f.first.id), job.kind);
    assert.equal(graph.facts.find(fact => fact.id === f.fact.id)!.deleted, undefined);
  } finally { f.close(); }
});

test("a concurrent manual reopen invalidates a deletion snapshot without fabricating an observed watermark", () => {
  const f = fixture();
  try {
    const job = f.store.claim(f.id, "decider", 0)!, read = f.store.get(f.id);
    f.store.reopenStep(f.id, f.first.id, { worker: "human", reason: "Revisit this premise" });
    const result = f.store.submitDecisions(f.id, submitDecisionsSchema.parse({ worker: job.worker, submission_id: "reopen-conflict",
      revision: read.revision, observation_revision: read.observation_revision, planning_revision: read.planning_revision,
      delete_nodes: [{ id: f.fact.id, reason: "Remove outdated material", cascade: "downstream" }] }), job.run_id);
    assert.equal(result.settle.ok, false);
    assert.ok(result.settle.conflicts.some(conflict => conflict.kind === "snapshot"));
    assert.equal(f.store.get(f.id).facts.find(fact => fact.id === f.fact.id)!.deleted, undefined);
    assert.equal(f.store.get(f.id).decided_revision, read.decided_revision);
  } finally { f.close(); }
});
