import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import { ControlPlaneMetrics } from "../../packages/core/src/control-plane.js";
import { DiagnosticRecords, type Diagnostic } from "../../packages/core/src/diagnostics.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";

test("control-plane timing separates route latency, slow outliers and SQLite write cost", () => {
  const metrics = new ControlPlaneMetrics();
  for (const ms of [10, 20, 30, 40]) metrics.recordRequest("/api/projects/:id", "GET", ms, 200);
  metrics.recordRequest("/api/projects/:id", "GET", 900, 500);
  metrics.recordRequest("/api/health", "GET", 2, 200);
  metrics.recordTransaction(5);
  metrics.recordTransaction(15);

  const snapshot = metrics.snapshot();
  const project = snapshot.requests.find(item => item.route === "/api/projects/:id" && item.method === "GET")!;
  assert.equal(project.count, 5);
  assert.equal(project.max_ms, 900);
  assert.equal(project.p50_ms, 30);
  assert.equal(project.route, snapshot.requests[0].route, "slowest route sorts first");
  assert.deepEqual(snapshot.slow.map(item => item.ms), [900]);
  assert.equal(snapshot.transactions.count, 2);
  assert.equal(snapshot.transactions.max_ms, 15);
  assert.equal(snapshot.event_loop.max_ms, 0, "unstarted collection reports zero, never a guess");
});

test("diagnostics record the server receipt time so delivery lag is measurable", () => {
  const store = new Store(":memory:");
  try {
    const graph = store.create(createProjectSchema.parse({ title: "Receipt", origin: "https://example.test", goal: "test" }));
    const job = store.claim(graph.project.id, "planner", 0)!;
    const records = new DiagnosticRecords(store.db);
    const before = Date.now();
    records.save(graph.project.id, job.run_id!, { id: randomUUID(), at: new Date(Date.now() - 8000).toISOString(),
      type: "tool_end", data: { tool: "read_graph" } } as Diagnostic);
    const [row] = records.page(graph.project.id, 0, records.highwater(graph.project.id));
    assert.equal(row.type, "tool_end");
    assert.ok(row.received_at, "export carries the receipt side of the timestamp pair");
    const lag = Date.parse(row.received_at) - Date.parse(row.at);
    assert.ok(lag >= 7000 && Date.parse(row.received_at) >= before - 1000, "sender clock skew stays visible, not corrected");
  } finally { store.close(); }
});
