import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, decideSchema, executeSchema, findingSchema, reviewSchema, type Job } from "../../packages/protocol/src/index.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { executeEntry } from "../../packages/core/src/projection.js";
import { reportFields } from "../fixtures/report.js";
import { cvss } from "../fixtures/cvss.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("Execute receives the complete linked subgoal, Step and current Hint without unrelated goals", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Intent delivery", origin: "https://example.test", goal: "Root intent",
      hints: [{ content: "Keep the specific final constraint: " + "important ".repeat(180) }] })).project.id;
    store.mutate(id, "fixture.goals", false, graph => {
      graph.goals.push({ id: "g001", description: "Check the full linked purpose: " + "purpose ".repeat(100), state: "active", graph_id: "main" });
      graph.goals.push({ id: "g002", description: "Unrelated purpose must not be injected", state: "active", graph_id: "main" });
    });
    const job = store.claim(id, "planner", 0)!;
    const graph = store.get(id);
    const description = ("Question: " + "complete intent ".repeat(100)).trim();
    commitPlan(store, id, decideSchema.parse({ worker: job.worker, revision: graph.revision, observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      steps: [{ from: ["origin"], description, goal_id: "g001", hint_ids: ["h001"] }] }));
    const execution = store.claim(id, "executor", 0)!;
    const view = executeEntry(store.get(id), execution);
    const focus = view.focus as { description: string; subgoal: { id: string; description: string } };
    assert.equal(focus.description, description);
    assert.equal(focus.subgoal.description, graph.goals.find(goal => goal.id === "g001")!.description);
    assert.equal(JSON.stringify(view).includes("Unrelated purpose must not be injected"), false);
    assert.equal((view.hints as { content: string }[])[0].content, graph.hints[0].content);
  } finally { store.close(); }
});

test("Decide sees every unclosed node; Execute and Review see only their direct support", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Projection", origin: "https://example.test", goal: "Assess" })).project.id;
    const evidence = store.addEvidence(id, { title: "Proof", content: "original body", encoding: "utf8", mime_type: "text/plain" });
    const step = store.manualStep(id, { from: ["origin"], description: "Probe the login flow", creator: "human", claim: true });
    const fact = store.fact(id, step.id, { worker: "human", description: "Login flow reaches the dashboard",
      conclusion: "未认证可进入面板", evidence_ids: [evidence.id] });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({
      title: "Missing authentication", description: "Dashboard is reachable anonymously", from: [fact.id], evidence_ids: [evidence.id],
    }));
    store.manualConclude(id, step.id, "human", "Flow captured");
    // Unrelated history must not leak into Execute/Review.
    store.mutate(id, "fixture.noise", true, graph => {
      for (let i = 0; i < 50; i++)
        graph.facts.push({ id: `f9${i}`, description: `Unrelated observation ${i}`, conclusion: `Unrelated ${i}`,
          status: "observed", graph_id: "main", evidence_ids: [] });
    });
    const graph = store.get(id);
    const decide = memoryEntry(graph, { kind: "decide", project_id: id, graph_id: "main", worker: "p" } as Job);
    assert.ok(decide.facts.some(line => line.includes("Unrelated observation 49")), "Decide entry is full");
    const execute = memoryEntry(graph, { kind: "execute", project_id: id, graph_id: "main", worker: "w", step_id: step.id } as Job);
    const executeView = JSON.stringify(execute);
    assert.match(executeView, /Probe the login flow/);
    assert.match(executeView, /未认证可进入面板/, "direct support keeps its conclusion");
    assert.ok(!executeView.includes("Unrelated observation 49"), "Execute does not load unrelated history");
    const review = memoryEntry(graph, { kind: "review", project_id: id, graph_id: "main", worker: "r", finding_id: finding.id } as Job);
    const reviewView = JSON.stringify(review);
    assert.match(reviewView, /Missing authentication/);
    assert.match(reviewView, /Login flow reaches the dashboard/, "Review reads the source Fact");
    assert.match(reviewView, /original body|Proof/, "Review gets the evidence list, not the whole graph");
    assert.ok(!reviewView.includes("Unrelated observation 49"), "Review does not read the whole graph");
  } finally { store.close(); }
});

test("Step priority drives claiming but never reorders the Decide entry", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Priority", origin: "https://example.test", goal: "Assess" })).project.id;
    const first = store.manualStep(id, { from: ["origin"], description: "First created, high priority", priority: 9, creator: "human" });
    const second = store.manualStep(id, { from: ["origin"], description: "Second created, low priority", priority: 0, creator: "human" });
    const entry = memoryEntry(store.get(id), { kind: "decide", project_id: id, graph_id: "main", worker: "p" } as Job);
    // The entry is a stable projection: creation order, regardless of priority.
    assert.deepEqual(entry.steps.map(line => line.split(" ")[0]), [first.id, second.id]);

    const planner = store.claim(id, "planner", 0)!;
    const graph = store.get(id);
    commitPlan(store, id, decideSchema.parse({ worker: planner.worker, revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision }));
    // Claiming is the scheduler's decision: it must pick the higher priority Step.
    const executor = store.claim(id, "executor", 0)!;
    assert.equal(executor.kind, "execute");
    assert.equal(executor.step_id, first.id);

    store.setCooldown(id, { hot_limit: 1000 });
    assert.equal(store.get(id).project.hot_limit, 1000);
    assert.throws(() => store.setCooldown(id, { hot_limit: 1001 }), /between 0 and 1000/);
  } finally { store.close(); }
});

test("Execute carries a retest Finding's claim even when no source Fact links it", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Retest claim", origin: "https://example.test", goal: "Assess" })).project.id;
    const evidence = store.addEvidence(id, { title: "Proof", content: "original body", encoding: "utf8", mime_type: "text/plain" });
    const finding = store.submitFinding(id, findingSchema.parse({ ...reportFields, title: "Missing authorization",
      description: "Dashboard is reachable anonymously", from: [], evidence_ids: [evidence.id],
      identity: { category: "access_control", host: "example.test", path: "/dashboard" } }));
    const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(id, finding.id, reviewSchema.parse({ worker: reviewer.worker, finding_version: 1, kind: "vulnerability",
      verdict: "pass", reason: "Evidence checked", cvss: cvss.high }));
    store.findingAction(id, finding.id, { action: "retest", expected_version: store.get(id).findings[0].version,
      creator: "operator", reason: "Verify the fix" });
    const step = store.get(id).steps.find(value => value.retest_finding_id === finding.id)!;
    assert.deepEqual(step.from, ["origin"]);
    const view = executeEntry(store.get(id), { kind: "execute", project_id: id, graph_id: "main", worker: "executor", step_id: step.id } as Job);
    assert.equal((view.focus as { retest_finding_id: string }).retest_finding_id, finding.id);
    const claim = (view.findings as { id: string; claim?: boolean; impact?: string; reproduction?: { steps: string[] };
      remediation?: string; truncated_fields?: string[] }[]).find(value => value.id === finding.id)!;
    assert.equal(claim.claim, true);
    assert.equal(claim.impact, reportFields.impact);
    assert.deepEqual(claim.reproduction!.steps, reportFields.reproduction.steps);
    assert.equal(claim.remediation, reportFields.remediation);

    // Pathological claims are bounded and say which fields were cut.
    store.mutate(id, "fixture.long-claim", false, graph => { graph.findings[0].impact = "A".repeat(5000); });
    const bounded = executeEntry(store.get(id), { kind: "execute", project_id: id, graph_id: "main", worker: "executor", step_id: step.id } as Job);
    const clipped = (bounded.findings as { id: string; impact?: string; truncated_fields?: string[] }[]).find(value => value.id === finding.id)!;
    assert.ok(clipped.impact!.length <= 1201);
    assert.ok(clipped.truncated_fields!.includes("impact"));
  } finally { store.close(); }
});

test("Execute carries the previous attempt, the approved asset and the producer's conclusion", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Retry context", origin: "https://example.test", goal: "Assess" })).project.id;
    const asset = store.get(id).assets[0];
    const produced = store.manualStep(id, { from: ["origin"], description: "Map the login flow", creator: "human", claim: true });
    store.execute(id, produced.id, executeSchema.parse({ worker: "human",
      facts: [{ description: "Login flow reaches the dashboard", conclusion: "Flow mapped", status: "observed", evidence_ids: [] }],
      summary: "Captured the login flow" }));
    store.closeStep(id, produced.id, { worker: "human", reason: "Flow is understood" });
    const fact = store.get(id).steps.find(value => value.id === produced.id)!.fact_ids[0];
    const step = store.manualStep(id, { from: [fact], description: "Verify the dashboard boundary", creator: "human", asset_id: asset.id });
    const view = executeEntry(store.get(id), { kind: "execute", project_id: id, graph_id: "main", worker: "executor", step_id: step.id } as Job);
    const source = (view.source_steps as { summary: string; close_reason: string }[])[0];
    assert.equal(source.summary, "Captured the login flow");
    assert.equal(source.close_reason, "Flow is understood");
    assert.equal((view.asset as { hostname: string }).hostname, asset.hostname);
    assert.equal((view.asset as { approval: string }).approval, "approved");

    const job = store.claim(id, "executor", deferDecideMs)!;
    assert.equal(job.kind, "execute");
    store.externalAction(id, job);
    store.release(id, job, "Connection lost after login");
    const retry = executeEntry(store.get(id), job);
    const focus = retry.focus as { blocked_run_id: string; last_summary: string };
    assert.equal(focus.blocked_run_id, job.run_id);
    assert.match(focus.last_summary, /Execution failed/);
    assert.match(focus.last_summary, /Connection lost/);
  } finally { store.close(); }
});

test("Decide's review issue carries the source Fact body, not only its id", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Review evidence", origin: "https://example.test", goal: "Assess" })).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Probe the record endpoint", creator: "human", claim: true });
    const fact = store.fact(id, step.id, { worker: "human",
      description: "The endpoint returns another user's record when id is changed",
      conclusion: "Cross-account read observed", evidence_ids: [] });
    const finding = store.submitStepFinding(id, step.id, "human", findingSchema.parse({ title: "Cross-account read",
      description: "Record boundary bypassed", from: [fact.id], evidence_ids: [] }));
    store.manualConclude(id, step.id, "human", "Probe complete");
    const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
    assert.equal(reviewer.kind, "review");
    store.review(id, finding.id, reviewSchema.parse({ worker: reviewer.worker, finding_version: 1, verdict: "needs_evidence",
      reason: "Reproduction steps do not name the second account", evidence_ids: [] }));
    const job = store.claim(id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    const entry = memoryEntry(store.get(id), job);
    const issue = (entry.review_issues as { source_facts: { id: string; description: string }[] }[])[0];
    assert.equal(issue.source_facts[0].id, fact.id);
    assert.match(issue.source_facts[0].description, /another user's record/);
  } finally { store.close(); }
});
