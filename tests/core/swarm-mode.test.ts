import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema, findingSchema, reviewSchema } from "../../packages/protocol/src/index.js";
import { peerEntry } from "../../packages/runner/src/run-support.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function swarm(store: Store, title = "Swarm") {
  return store.create(
    createProjectSchema.parse({ title, origin: "https://example.test", goal: "Assess", mode: "swarm" }),
  ).project.id;
}

test("swarm project starts with one active peer; classic still schedules Decide", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const graph = store.get(id);
  assert.equal(graph.project.mode, "swarm");
  assert.equal(graph.peers?.length, 1);
  assert.equal(graph.peers?.[0].id, "p001");
  assert.equal(graph.peers?.[0].status, "active");

  const job = store.claim(id, "w1", 0)!;
  assert.equal(job.kind, "peer");
  assert.equal(job.peer_id, "p001");

  const classic = store.create(
    createProjectSchema.parse({ title: "Classic", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  assert.equal(store.get(classic).project.mode, undefined);
  assert.equal(store.claim(classic, "w2", 0)!.kind, "decide");
});

test("operator replaces the last retired peer without reviving its session", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    assert.throws(() => store.operatorReplacePeer(id), /active peer/);
    const job = store.claim(id, "w1", 0)!;
    store.swarmRetire(id, "p001", { reason: "finished" }, job.run_id!);
    assert.throws(() => store.operatorReplacePeer(id), /still running/);
    store.release(id, job);
    const peer = store.operatorReplacePeer(id);
    assert.equal(peer.id, "p002");
    assert.equal(peer.origin, "operator");
    assert.equal(store.claim(id, "w2", 0)?.peer_id, "p002");
    assert.equal(store.get(id).peers?.[0].status, "retired");
  } finally {
    store.close();
  }
});

test("stalled warning waits for the grace period and can be cleared by retry", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const job = store.claim(id, "w1", 0)!;
    store.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "waiting" }, job.run_id!);
    store.release(id, job);
    assert.equal(store.swarmView(id).stalled, false);
    store.db
      .prepare("UPDATE project_peer_state SET last_turn_at=? WHERE project_id=?")
      .run(new Date(Date.now() - 360_000).toISOString(), id);
    assert.equal(store.swarmView(id).stalled, true);
    store.retryPeer(id, "p001");
    assert.equal(store.swarmView(id).stalled, false);
    assert.equal(store.claim(id, "w2", 0)?.peer_id, "p001");
  } finally {
    store.close();
  }
});

test("peer handoff bounds negative scope and preserves evidence references", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.get(swarm(store));
    graph.facts.push({
      id: "f001",
      graph_id: "main",
      description: "negative",
      status: "not_observed",
      evidence_ids: ["e001"],
      run_id: "r001",
      request: { method: "GET", url: "https://example.test/x" },
      negative_scope: {
        attempted: Array(20).fill("x".repeat(500)),
        not_tested: Array(20).fill("y".repeat(500)),
        confidence: "low",
      },
    });
    const fact = peerEntry(graph, {}, [], "p001").shared.facts.find((item) => item.id === "f001")!;
    assert.deepEqual(fact.evidence_ids, ["e001"]);
    assert.equal(fact.run_id, "r001");
    assert.equal(fact.negative_scope?.truncated, true);
    assert.ok(JSON.stringify(fact).length < 1500);
  } finally {
    store.close();
  }
});

test("turn-end advances seen watermarks and wake; waiting peer is not claimed again", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  const ended = store.swarmTurnEnd(
    id,
    "p001",
    { worker: "w1", wake: "waiting", direction: "recon", summary: "probed" },
    job.run_id!,
  );
  assert.equal(ended.wake, "waiting");
  store.release(id, job);
  // No new shared state: a waiting peer is not due.
  assert.equal(store.claim(id, "w2", 0), null);
});

test("messages are delivered by seq and make a spawned peer eligible for a turn", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  // p001 spawns p002 and hands it a message inside the same turn.
  const child = store.swarmSpawn(id, "p001", { reason: "parallel auth probe", direction: "auth" }, job.run_id!);
  assert.equal(child.id, "p002");
  // 新执行者必须有独立的回合水位行，否则「执行者」页只能显示无状态。
  assert.equal(store.swarm.states(id).get(child.id)?.wake, "ready");
  // spawn 同时广播一条系统消息：同伴在收件箱里就能知道新执行者加入。
  const messages = store.swarmMessages(id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "system");
  assert.equal(messages[0].from_peer, null, "system messages come from the runtime, never a peer");
  assert.ok(messages[0].refs.includes(child.id));
  const message = store.swarmSendMessage(
    id,
    "p001",
    { to: "p002", kind: "question", body: "check login", refs: [] },
    job.run_id!,
  );
  assert.equal(message.seq, 2);
  const inbox = store.swarmInbox(id, "p002");
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].kind, "system");
  assert.equal(inbox[1].body, "check login");
  store.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "" }, job.run_id!);
  store.release(id, job);
  const next = store.claim(id, "w2", 0)!;
  assert.equal(next.kind, "peer");
  assert.equal(next.peer_id, "p002");
});

test("handoffs require a real fact or evidence and spawn preserves references", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const job = store.claim(id, "w1", 0)!;
    const evidence = store.addEvidence(id, {
      title: "response",
      content: "response",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    assert.throws(
      () => store.swarmSendMessage(id, "p001", { kind: "handoff", body: "result", refs: ["missing"] }, job.run_id!),
      /交接须引用/,
    );
    assert.throws(
      () => store.swarmSpawn(id, "p001", { reason: "split", start_message: "result" }, job.run_id!),
      /交接须引用/,
    );
    assert.equal(store.get(id).peers?.length, 1);
    const peer = store.swarmSpawn(
      id,
      "p001",
      { reason: "split", start_message: "result", start_refs: [evidence.id] },
      job.run_id!,
    );
    const handoff = store.swarmInbox(id, peer.id).find((message) => message.kind === "handoff")!;
    assert.deepEqual(handoff.refs, [evidence.id]);
    assert.deepEqual(
      store.swarmSendMessage(id, "p001", { kind: "handoff", body: "result", refs: [evidence.id] }, job.run_id!).refs,
      [evidence.id],
    );
  } finally {
    store.close();
  }
});

test("unanimous consensus completes a swarm project once the turn releases", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  const round = store.swarmProposeCompletion(id, "p001", { reason: "enough", coverage: [] }, job.run_id!);
  assert.equal(round.status, "open");
  store.swarmRespondCompletion(id, "p001", { round_id: round.id, opinion: "agree" }, job.run_id!);
  // A running turn blocks commit (no unsettled activity); releasing the turn finalizes.
  assert.equal(store.get(id).project.status, "active");
  store.release(id, job);
  assert.equal(store.get(id).project.status, "completed");
  assert.equal(store.get(id).rounds?.find((r) => r.id === round.id)?.status, "committed");
});

test("a message invalidates an open round before everyone agrees", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  const child = store.swarmSpawn(id, "p001", { reason: "split" }, job.run_id!);
  assert.equal(child.id, "p002");
  const round = store.swarmProposeCompletion(id, "p001", { reason: "done", coverage: [] }, job.run_id!);
  store.swarmSendMessage(id, "p001", { kind: "share", body: "found more", refs: [] }, job.run_id!);
  assert.throws(() => store.swarmRespondCompletion(id, "p001", { round_id: round.id, opinion: "agree" }, job.run_id!));
  assert.equal(store.get(id).project.status, "active");
});

test("retiring every peer leaves no active participant, so completion cannot start", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  store.swarmRetire(id, "p001", { reason: "nothing left" }, job.run_id!);
  assert.equal(store.get(id).peers?.[0].status, "retired");
  // 退出也写一条系统消息，同伴/运营时间线都能看到这次共享状态变化。
  const system = store.swarmMessages(id).find((m) => m.kind === "system");
  assert.ok(system?.body.includes("p001 退出"));
  assert.throws(() => store.swarmProposeCompletion(id, "p001", { reason: "done", coverage: [] }));
});

test("peer turn heartbeat and external action are accepted (no 404/409)", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  assert.deepEqual(store.heartbeat(id, job), { ok: true });
  assert.deepEqual(store.externalAction(id, job), { ok: true });
  assert.equal(store.execution.get(id, job.run_id!)!.external_action_possible, true);
});

test("turn-end only advances to the delivered message seq, so a truncated inbox is redelivered", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const first = store.swarm.append(id, { from: "p002", to: "p001", kind: "share", body: "one", refs: [] });
  const second = store.swarm.append(id, { from: "p002", to: "p001", kind: "share", body: "two", refs: [] });
  assert.ok(second.seq > first.seq);
  const job = store.claim(id, "w1", 0)!;
  assert.equal(job.peer_id, "p001");
  // Simulate a truncated delivery: only the first message reached the peer this turn.
  store.swarmTurnEnd(
    id,
    "p001",
    { worker: "w1", wake: "waiting", summary: "", seen_message_seq: first.seq },
    job.run_id!,
  );
  store.release(id, job);
  const states = store.swarm.states(id);
  assert.equal(states.get("p001")!.seen_message_seq, first.seq);
  // The second message is still unread, so the peer must be due again (no silent loss).
  const next = store.claim(id, "w2", 0)!;
  assert.equal(next.kind, "peer");
  assert.equal(next.peer_id, "p001");
});

test("turn-end cannot push the delivered watermark past the messages that exist", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const only = store.swarm.append(id, { from: "p002", to: "p001", kind: "share", body: "one", refs: [] });
  const job = store.claim(id, "w1", 0)!;
  store.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "", seen_message_seq: 9999 }, job.run_id!);
  assert.equal(store.swarm.state(id, "p001").seen_message_seq, only.seq);
});

test("swarm fact records an approved asset id and rejects an unapproved one", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  store.mutate(id, "fixture.asset", true, (graph) => {
    graph.assets.push({
      id: "a002",
      hostname: "app.example.test",
      source: "seed",
      approval: "approved",
      seed: true,
      evidence_ids: [],
      created_at: new Date().toISOString(),
      approved_at: new Date().toISOString(),
      graph_id: "main",
    });
    graph.assets.push({
      id: "a003",
      hostname: "pending.example.test",
      source: "discovery",
      approval: "pending",
      seed: false,
      evidence_ids: [],
      created_at: new Date().toISOString(),
      graph_id: "main",
    });
  });
  const job = store.claim(id, "w1", 0)!;
  const fact = store.swarmFact(
    id,
    "p001",
    {
      worker: "w1",
      description: "app home",
      conclusion: "app 首页可访问",
      objects: ["/home"],
      evidence_ids: [],
      asset_id: "a002",
    },
    job.run_id!,
  );
  assert.equal(fact.asset_id, "a002");
  assert.throws(() =>
    store.swarmFact(
      id,
      "p001",
      { worker: "w1", description: "pending host", evidence_ids: [], asset_id: "a003" },
      job.run_id!,
    ),
  );
});

test("peer failures are counted per peer, not in a shared global bucket", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  store.release(id, job, "boom");
  const failures = store.get(id).project.job_failures ?? {};
  assert.equal(failures["peer:p001"], 1, "failure is scoped to the peer");
  assert.equal(failures.peer ?? 0, 0, "no shared peer bucket accumulates");
});

test("a model failure backs off the project but does not consume a peer's business failure budget", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const job = store.claim(id, "w1", 0)!;
  store.release(id, job, "Model provider failure: 503: overloaded");
  const graph = store.get(id);
  assert.equal(graph.project.job_failures?.["peer:p001"] ?? 0, 0, "model blips are not peer business failures");
  assert.equal(store.swarm.state(id, "p001").wake, "ready", "the peer is retried after the model backoff");
  assert.ok(graph.project.model_retry_at, "the project still backs off model failures");
});

test("a persistently failing peer is parked (stuck), not the whole swarm, and the operator can retry", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  for (let i = 0; i < 3; i++) {
    const job = store.claim(id, `w${i}`, 0)!;
    assert.equal(job.kind, "peer");
    assert.equal(job.peer_id, "p001");
    store.release(id, job, "boom");
  }
  const graph = store.get(id);
  assert.equal(graph.project.status, "active", "one broken peer must not pause the whole swarm");
  assert.equal(graph.project.job_failures?.["peer:p001"], 3);
  assert.equal(store.swarm.state(id, "p001").wake, "stuck");
  // A stuck peer is not scheduled again until an operator intervenes.
  assert.equal(store.claim(id, "w9", 0), null);
  // Operator retry re-arms it and clears the counter.
  store.retryPeer(id, "p001");
  assert.equal(store.swarm.state(id, "p001").wake, "ready");
  assert.equal(store.get(id).project.job_failures?.["peer:p001"], 0);
  assert.equal(store.claim(id, "w10", 0)?.peer_id, "p001");
});

test("spawning or retiring a peer does not clear another peer's stuck gate", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const first = store.claim(id, "w1", 0)!;
  const child = store.swarmSpawn(id, "p001", { reason: "split" }, first.run_id!);
  store.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "" }, first.run_id!);
  store.release(id, first);
  // p001 is parked by the operator/failure policy; p002 still works.
  store.swarm.setWake(id, "p001", "stuck");
  const second = store.claim(id, "w2", 0)!;
  assert.equal(second.peer_id, child.id);
  store.swarmSpawn(id, "p002", { reason: "further split" }, second.run_id!);
  assert.equal(store.swarm.state(id, "p001").wake, "stuck", "spawn must not bypass the operator gate");
  store.swarmRetire(id, "p002", { reason: "done" }, second.run_id!);
  assert.equal(store.swarm.state(id, "p001").wake, "stuck", "retire must not bypass the operator gate");
});

test("swarm message retention prunes only acknowledged messages beyond the window", () => {
  const store = new Store(":memory:");
  const id = swarm(store);
  const previous = process.env.TESSERA_SWARM_MESSAGE_KEEP;
  process.env.TESSERA_SWARM_MESSAGE_KEEP = "3";
  try {
    for (let i = 0; i < 10; i++)
      store.swarm.append(id, { from: "p002", to: "p001", kind: "share", body: `m${i}`, refs: [] });
    const job = store.claim(id, "w1", 0)!;
    assert.equal(job.peer_id, "p001");
    // Everything was delivered this turn, so turn-end prunes down to the newest 3.
    store.swarmTurnEnd(id, "p001", { worker: "w1", wake: "waiting", summary: "", seen_message_seq: 10 }, job.run_id!);
    const remaining = store.swarm.list(id);
    assert.deepEqual(
      remaining.map((message) => message.seq),
      [8, 9, 10],
    );
    // The high-watermark is preserved, so new messages keep increasing.
    const next = store.swarm.append(id, { from: "p002", to: "p001", kind: "share", body: "m11", refs: [] });
    assert.equal(next.seq, 11);
    store.release(id, job);
  } finally {
    if (previous === undefined) delete process.env.TESSERA_SWARM_MESSAGE_KEEP;
    else process.env.TESSERA_SWARM_MESSAGE_KEEP = previous;
  }
});

test("replacement cannot overlook a running peer beyond history pagination", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store),
      job = store.claim(id, "w1", 0)!;
    const run = store.execution.get(id, job.run_id!)!;
    store.swarmRetire(id, "p001", { reason: "retiring" }, job.run_id!);
    for (let i = 0; i < 1000; i++)
      store.execution.save({ ...run, id: "history-" + i, status: "succeeded", finished_at: new Date().toISOString() });
    assert.equal(store.execution.hasRunning(id), true);
    assert.throws(() => store.operatorReplacePeer(id), /still running/);
    store.release(id, job);
    assert.equal(store.execution.hasRunning(id), false);
    assert.equal(store.operatorReplacePeer(id).origin, "operator");
  } finally {
    store.close();
  }
});

/** A reviewed finding with one high-risk Review question, the shape that used to slip past swarm completion. */
function reviewedSwarmFinding(store: Store, id: string, issue = "疑似 IDOR：可按记录编号读取他人数据") {
  const evidence = store.addEvidence(id, {
    title: "Original",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.swarmFinding(
    id,
    "p001",
    findingSchema.parse({
      ...reportFields,
      title: "跨账号记录读取",
      description: "使用测试账号读取了另一账号的记录。",
      evidence_ids: [evidence.id],
    }),
  );
  const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
  assert.equal(reviewer.kind, "review");
  store.review(
    id,
    finding.id,
    reviewSchema.parse({
      worker: reviewer.worker,
      finding_version: finding.version,
      verdict: "pass",
      kind: "vulnerability",
      reason: "已核对原始响应",
      evidence_ids: [evidence.id],
      cvss: cvss.high,
      planning_issues: [issue],
    }),
  );
  return { evidence, finding };
}

test("swarm completion cannot skip a Review issue and only fresh evidence can address it", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const { evidence } = reviewedSwarmFinding(store, id);
    const job = store.claim(id, "w1", 0)!;
    assert.equal(job.kind, "peer");

    assert.throws(
      () => store.swarmProposeCompletion(id, "p001", { reason: "done", coverage: [] }, job.run_id!),
      /完成共识被拒绝[\s\S]*尚未处置/,
    );
    // Reusing the evidence that predates the Review is not "addressing" the question.
    assert.throws(
      () =>
        store.swarmProposeCompletion(
          id,
          "p001",
          {
            reason: "done",
            coverage: [],
            review_issues: [{ review_id: "r001", issue_index: 0, status: "addressed", evidence_ids: [evidence.id] }],
          },
          job.run_id!,
        ),
      /没有引用审核之后保存的新原始证据/,
    );

    // The follow-up becomes proof only once it is saved after the Review and referenced by a Fact.
    const fresh = store.addEvidence(id, {
      title: "Retest",
      content: "still exposed",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    store.swarmFact(id, "p001", {
      worker: "w1",
      description: "重测仍可跨账号读取记录",
      evidence_ids: [fresh.id],
    });
    const round = store.swarmProposeCompletion(
      id,
      "p001",
      {
        reason: "done",
        coverage: [],
        review_issues: [{ review_id: "r001", issue_index: 0, status: "addressed", evidence_ids: [fresh.id] }],
      },
      job.run_id!,
    );
    store.swarmRespondCompletion(id, "p001", { round_id: round.id, opinion: "agree" }, job.run_id!);
    store.release(id, job);

    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    // swarm has no Step queue: completion must not synthesize the classic completion Step.
    assert.equal(graph.steps.length, 0);
    assert.equal(graph.project.completion?.review_issues?.[0]?.status, "addressed");
    assert.equal(graph.project.pending_completion, undefined);
  } finally {
    store.close();
  }
});

test("swarm completion waits until every active peer has read its messages", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    // A peer's finding that nobody has read yet must not be overridden by silence.
    store.swarm.append(id, {
      from: "p002",
      to: "p001",
      kind: "share",
      body: "still checking the upload path",
      refs: [],
    });
    const job = store.claim(id, "w1", 0)!;
    const round = store.swarmProposeCompletion(id, "p001", { reason: "done", coverage: [] }, job.run_id!);
    store.swarmRespondCompletion(id, "p001", { round_id: round.id, opinion: "agree" }, job.run_id!);
    store.release(id, job);
    assert.equal(store.get(id).project.status, "active", "unread messages must block the commit");
    assert.equal(store.get(id).rounds?.find((r) => r.id === round.id)?.status, "open");

    // The next turn delivers the message; turn-end advances the watermark and the same round commits.
    const next = store.claim(id, "w2", 0)!;
    assert.equal(next.kind, "peer");
    store.swarmTurnEnd(
      id,
      "p001",
      { worker: "w2", wake: "waiting", summary: "", seen_message_seq: store.swarm.maxSeq(id) },
      next.run_id!,
    );
    // The turn's own Run is still leased at turn-end; releasing it is what lets the commit evaluate again.
    store.release(id, next);
    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.rounds?.find((r) => r.id === round.id)?.status, "committed");
  } finally {
    store.close();
  }
});

test("an open operator Hint never requires a manual click before swarm completion", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    store.hint(id, "重点看上传接口", "operator");
    const job = store.claim(id, "w1", 0)!;
    const round = store.swarmProposeCompletion(id, "p001", { reason: "hint was read", coverage: [] }, job.run_id!);
    store.swarmRespondCompletion(id, "p001", { round_id: round.id, opinion: "agree" }, job.run_id!);
    store.release(id, job);
    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    // The directive stays on the graph for the operator: autonomy does not delete instructions.
    assert.equal(graph.hints[0].resolved, undefined);
  } finally {
    store.close();
  }
});

test("a human retest in swarm is a runtime message, not an orphan Step", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const { finding } = reviewedSwarmFinding(store, id, "复核错误页是否泄露组件版本");
    store.findingAction(id, finding.id, {
      action: "retest",
      expected_version: finding.version,
      creator: "operator",
      reason: "在真实环境下再确认一次",
    });
    const graph = store.get(id);
    assert.equal(graph.steps.length, 0, "swarm must not create a Step nobody can claim");
    assert.equal(graph.findings[0].human_feedback?.step_id, undefined);
    const message = store.swarmMessages(id).find((item) => item.kind === "system" && item.body.includes(finding.id));
    assert.ok(message?.body.includes("重测"));
    // The retest request still has to clear the completion gates: unread message + Review issue.
    const job = store.claim(id, "w1", 0)!;
    assert.throws(
      () => store.swarmProposeCompletion(id, "p001", { reason: "done", coverage: [] }, job.run_id!),
      /完成共识被拒绝/,
    );
  } finally {
    store.close();
  }
});

test("peer entry carries changes since the peer's watermark and the open Review issues", () => {
  const store = new Store(":memory:");
  try {
    const id = swarm(store);
    const graph = store.get(id);
    const view = peerEntry(
      graph,
      {
        peers: [],
        rounds: [],
        review_issues: [{ review_id: "r001", issue_index: 0, risk: "high", issue: "疑似 IDOR：读取他人记录" }],
        changes: [{ kind: "facts", id: "f001", revision: 4, event_kind: "fact.observed", preview: "观测到上传入口" }],
        changes_total: 1,
        changes_remaining: 0,
        since_revision: 3,
      },
      [],
      "p001",
    ) as unknown as {
      changes_since_seen: { since_revision: number; total: number; items: { id: string; kind: string }[] };
      review_issues: { review_id: string; risk: string }[];
    };
    assert.equal(view.changes_since_seen.since_revision, 3);
    assert.equal(view.changes_since_seen.total, 1);
    assert.equal(view.changes_since_seen.items[0]?.id, "f001");
    assert.equal(view.review_issues[0]?.review_id, "r001");
  } finally {
    store.close();
  }
});
