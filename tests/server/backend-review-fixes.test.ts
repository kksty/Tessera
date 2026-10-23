import { commitPlan } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import { createProjectSchema, decideSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";
import { SubmissionOutbox, loadSubmission, replaySubmission } from "../../packages/runner/src/submissions.js";
import { ApiClient } from "../../packages/runner/src/client.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { buildApp, testWorkerToken } from "../helpers/server.js";

function fixture(hints: { content: string }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "tessera-review-fixes-"));
  const file = join(dir, "graph.db");
  let store = new Store(file);
  const id = store.create(
    createProjectSchema.parse({ title: "Regression", origin: "https://example.test", goal: "Assess", hints }),
  ).project.id;
  const submit = (worker: string, submission_id: string, input: Record<string, unknown>) => {
    const graph = store.get(id);
    return store.submitDecisions(
      id,
      submitDecisionsSchema.parse({
        worker,
        submission_id,
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        ...input,
      }),
    );
  };
  return {
    dir,
    id,
    submit,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new Store(file);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const complete of [false, true])
  test(`Decide HTTP receipts survive lost responses and restart (${complete ? "complete" : "plan"})`, async () => {
    const f = fixture();
    const job = f.store.claim(f.id, "planner", 0)!;
    const snapshot = f.store.get(f.id);
    const runtime = new RuntimeConfig(join(f.dir, "runtime.json"), {});
    let app = buildApp(f.store, runtime, join(f.dir, "no-web"));
    let calls = 0;
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.url.endsWith("/decisions")) {
        calls++;
        reply.raw.destroy();
      }
      return payload;
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const client = new ApiClient(app.listeningOrigin, testWorkerToken);
      const outbox = new SubmissionOutbox(f.dir, job, client);
      const file = await outbox.prepare(
        client.projectPath(job, "/fgs/decisions"),
        {
          worker: job.worker,
          revision: snapshot.revision,
          observation_revision: snapshot.observation_revision,
          planning_revision: snapshot.planning_revision,
          ...(complete
            ? { complete: { from: ["origin"], description: "Assessment complete" } }
            : { steps: [{ from: ["origin"], description: "Probe once" }] }),
        },
        true,
      );
      await assert.rejects(replaySubmission(file, client));
      assert.equal(calls, 3, "all transport retries must return the accepted receipt");
      assert.equal((await loadSubmission(file)).record.state, "pending");
      assert.equal(f.store.runs(f.id)[0].status, "succeeded");
      const committed = f.store.get(f.id);
      await app.close();
      f.restart();
      app = buildApp(f.store, runtime, join(f.dir, "no-web"));
      await app.listen({ host: "127.0.0.1", port: 0 });
      const recovered = new ApiClient(app.listeningOrigin, testWorkerToken);
      const first = await replaySubmission(file, recovered);
      assert.deepEqual(await replaySubmission(file, recovered), first);
      assert.equal((await loadSubmission(file)).record.state, "accepted");
      assert.deepEqual(f.store.get(f.id), committed, "replay cannot repeat any business writes");
      const saved = (await loadSubmission(file)).record;
      await assert.rejects(
        recovered.commit(
          saved.operation,
          { ...saved.payload, steps: [{ from: ["origin"], description: "Changed" }], complete: undefined },
          job.run_id,
          saved.submission_id,
        ),
        /409/,
      );
      await assert.rejects(recovered.commit(saved.operation, saved.payload, job.run_id, "new-key"), /409/);
    } finally {
      await app.close();
      f.close();
    }
  });

test("an unaccepted Decide submission cannot use a released Run", async () => {
  const f = fixture();
  const app = buildApp(f.store, new RuntimeConfig(join(f.dir, "runtime.json"), {}), join(f.dir, "no-web"));
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const graph = f.store.get(f.id);
    f.store.release(f.id, job);
    const next = f.store.claim(f.id, job.worker, 0)!;
    assert.notEqual(next.run_id, job.run_id);
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${f.id}/fgs/decisions`,
      headers: { "x-tessera-worker-token": testWorkerToken },
      payload: {
        run_id: job.run_id,
        submission_id: "stale",
        worker: job.worker,
        revision: graph.revision,
        observation_revision: graph.observation_revision,
        planning_revision: graph.planning_revision,
        steps: [{ from: ["origin"], description: "Stale" }],
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(f.store.get(f.id).steps.length, 0);
  } finally {
    await app.close();
    f.close();
  }
});

test("closing the last queued Step wakes Decide and allows completion", () => {
  const f = fixture();
  try {
    const planner = f.store.claim(f.id, "planner", 0)!;
    f.submit(planner.worker, "plan", { steps: [{ from: ["origin"], description: "Queued" }] });
    f.store.closeStep(f.id, "s001", { worker: "human", reason: "No longer needed" });
    const graph = f.store.get(f.id);
    assert.ok(graph.observation_revision > graph.decided_revision);
    const next = f.store.claim(f.id, "closer", 0)!;
    assert.equal(next?.kind, "decide");
    assert.equal(
      f.submit(next.worker, "complete", { complete: { from: ["origin"], description: "Done" } }).settle.ok,
      true,
    );
    assert.equal(f.store.get(f.id).project.status, "completed");
  } finally {
    f.close();
  }
});

for (const closed of [false, true])
  test(`rewritten Hints require fresh coverage despite ${closed ? "closed" : "discarded"} historical Steps`, () => {
    const f = fixture([{ content: "Check A" }]);
    try {
      const planner = f.store.claim(f.id, "planner", 0)!;
      f.submit(planner.worker, "plan", { steps: [{ from: ["origin"], description: "Check A", hint_ids: ["h001"] }] });
      if (closed) f.store.closeStep(f.id, "s001", { worker: "human", reason: "A is done" });
      // Older persisted projects have associations but neither version field.
      f.store.mutate(f.id, "", false, (graph) => {
        delete graph.steps[0].hint_versions;
        delete graph.hints[0].version;
      });
      f.store.updateHint(f.id, "h001", { content: "Check entirely different B", step_ids: ["s001"] });
      f.restart();
      const next = f.store.claim(f.id, "planner-b", 0)!;
      assert.equal(next.kind, "decide");
      const graph = f.store.get(f.id);
      assert.deepEqual(graph.steps[0].hint_ids, ["h001"], "keep the historical association");
      const view = memoryEntry(graph, next) as { unaddressed_hints: string[]; hints: string[] };
      assert.deepEqual(view.unaddressed_hints, ["h001"]);
      assert.match(view.hints[0], /待人工确认/);
      assert.throws(
        () =>
          commitPlan(
            f.store,
            f.id,
            decideSchema.parse({
              worker: next.worker,
              revision: graph.revision,
              observation_revision: graph.observation_revision,
              planning_revision: graph.planning_revision,
              complete: { from: ["origin"], description: "Premature" },
            }),
          ),
        /Hint 需人工确认/,
      );
      const refused = f.submit(next.worker, "refused", { complete: { from: ["origin"], description: "Premature" } });
      assert.equal(refused.settle.ok, false);
      assert.match(refused.settle.conflicts[0].reason, /Hint 需人工确认/);
      const noted = f.submit(next.worker, "answered", {
        hint_notes: [{ id: "h001", note: "B requires a separate scope" }],
        complete: { from: ["origin"], description: "Done with explanation" },
      });
      assert.equal(noted.settle.ok, false, "a model note is not operator closure");
      assert.equal(f.store.get(f.id).hints[0].resolved, undefined);
      f.store.resolveHint(f.id, "h001", { note: "B requires a separate scope" });
      assert.equal(
        f.submit(next.worker, "confirmed", { complete: { from: ["origin"], description: "Done with explanation" } })
          .settle.ok,
        true,
      );
    } finally {
      f.close();
    }
  });

test("a Hint rewrite rejects plans and notes based on the old snapshot", () => {
  const f = fixture([{ content: "Check A" }]);
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    const graph = f.store.get(f.id);
    f.store.updateHint(f.id, "h001", { content: "Check B" });
    for (const input of [
      { steps: [{ from: ["origin"], description: "Stale A", hint_ids: ["h001"] }] },
      { hint_notes: [{ id: "h001", note: "A was already handled" }] },
    ]) {
      assert.throws(
        () =>
          f.store.submitDecisions(
            f.id,
            submitDecisionsSchema.parse({
              worker: job.worker,
              submission_id: JSON.stringify(input),
              revision: graph.revision,
              observation_revision: graph.observation_revision,
              planning_revision: graph.planning_revision,
              ...input,
            }),
          ),
        /Graph changed/,
      );
    }
    assert.equal(f.store.get(f.id).steps.length, 0);
    assert.equal(f.store.get(f.id).hints[0].resolved, undefined);
    const accepted = f.submit(job.worker, "fresh-b", {
      steps: [{ from: ["origin"], description: "Check B", hint_ids: ["h001"] }],
    });
    assert.equal(accepted.settle.ok, true);
    assert.deepEqual((memoryEntry(f.store.get(f.id), job) as { unaddressed_hints: string[] }).unaddressed_hints, []);
  } finally {
    f.close();
  }
});

test("fresh plans and explicit reassociation cover the current Hint version", () => {
  const f = fixture([{ content: "Check A" }]);
  try {
    const job = f.store.claim(f.id, "planner", 0)!;
    f.submit(job.worker, "plan-a", { steps: [{ from: ["origin"], description: "Check A", hint_ids: ["h001"] }] });
    f.store.updateHint(f.id, "h001", { content: "Check B" });
    const next = f.store.claim(f.id, "planner-b", 0)!;
    assert.equal(
      f.submit(next.worker, "plan-b", { steps: [{ from: ["origin"], description: "Check B", hint_ids: ["h001"] }] })
        .settle.ok,
      true,
    );
    let graph = f.store.get(f.id);
    assert.deepEqual(graph.steps[0].hint_versions, { h001: 1 });
    assert.deepEqual(graph.steps[1].hint_versions, { h001: 2 });
    assert.deepEqual((memoryEntry(graph, next) as { unaddressed_hints: string[] }).unaddressed_hints, []);
    f.store.updateHint(f.id, "h001", { content: "Check B more carefully" });
    // A subsequent explicit human association can attest an existing result.
    f.store.updateHint(f.id, "h001", { step_ids: ["s002"] });
    graph = f.store.get(f.id);
    assert.deepEqual(graph.steps[1].hint_versions, { h001: 3 });
    assert.deepEqual((memoryEntry(graph, next) as { unaddressed_hints: string[] }).unaddressed_hints, []);
  } finally {
    f.close();
  }
});
