import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { applyFindingMerges } from "../../packages/core/src/finding-merges.js";
import { createProjectSchema, findingSchema } from "../../packages/protocol/src/index.js";
import { trafficRecordSchema } from "../../packages/protocol/src/traffic.js";

const stamp = () => new Date().toISOString();

function flow(overrides: Record<string, unknown>) {
  return trafficRecordSchema.parse({
    id: "flow-1",
    created_at: stamp(),
    method: "GET",
    url: "https://api.example.test/users/7",
    host: "api.example.test",
    protocol: "HTTP/1.1",
    status: 200,
    duration_ms: 12,
    request: { head: "GET /users/7 HTTP/1.1\r\nHost: api.example.test\r\nAccept: application/json", size: 0 },
    response: {
      head: "HTTP/1.1 200 OK\r\nContent-Type: application/json",
      size: 17,
      body_base64: Buffer.from('{"id":7,"name":"ada"}').toString("base64"),
    },
    ...overrides,
  });
}

test("finding traffic keeps explicit HTTP flows and rejects non-HTTP or missing ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-finding-traffic-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Traffic links", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    const http = flow({ id: "flow-http", step_id: "s001", run_id: "run-1" });
    const connection = flow({
      id: "flow-conn",
      capture_kind: "connection",
      capture_state: "open",
      status: null,
      response: null,
    });
    store.traffic.ingest(id, [http, connection]);

    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "IDOR on user profile",
        description: "The API returned another user's profile.",
        traffic_ids: ["flow-http", "flow-conn", "missing"],
      }),
    );
    assert.deepEqual(finding.traffic_ids, ["flow-http"], "only existing HTTP flows are stored");

    const linked = store.findingTraffic(id, finding.id);
    assert.equal(linked.source, "linked");
    assert.deepEqual(
      linked.records.map((record) => record.id),
      ["flow-http"],
    );
    assert.equal(linked.records[0].url, "https://api.example.test/users/7");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repeated delivery stays idempotent even when it cites a flow that is not ingested yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-finding-replay-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Replay links", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [flow({ id: "flow-http" })]);
    const input = findingSchema.parse({
      title: "IDOR on user profile",
      description: "The API returned another user's profile.",
      identity: { category: "access-control", method: "GET", path: "/users/7", host: "api.example.test" },
      // The recorder may lag behind the request; a missing id is dropped on write.
      traffic_ids: ["flow-http", "not-uploaded-yet"],
    });
    const first = store.submitFinding(id, input);
    const replay = store.submitFinding(id, input);
    assert.equal(replay.id, first.id, "the same delivery must reuse the Finding instead of creating a duplicate");
    assert.equal(replay.version, first.version);
    assert.deepEqual(replay.traffic_ids, ["flow-http"]);
    assert.deepEqual(
      store.get(id).findings.map((finding) => finding.id),
      [first.id],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merging findings keeps every source's traffic links", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-finding-merge-traffic-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Merged links", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [flow({ id: "flow-a" }), flow({ id: "flow-b", url: "https://api.example.test/users/8" })]);
    const target = store.submitFinding(
      id,
      findingSchema.parse({
        title: "Record of user 7",
        description: "One proof.",
        identity: { category: "access-control", method: "GET", path: "/users/7", host: "api.example.test" },
        traffic_ids: ["flow-a"],
      }),
    );
    const source = store.submitFinding(
      id,
      findingSchema.parse({
        title: "Record of user 8",
        description: "Restated proof.",
        identity: { category: "access-control", method: "GET", path: "/users/8", host: "api.example.test" },
        traffic_ids: ["flow-b"],
      }),
    );
    const graph = store.get(id);
    applyFindingMerges(
      graph,
      [
        {
          target_id: target.id,
          source_ids: [source.id],
          expected_versions: { [target.id]: target.version, [source.id]: source.version },
          reason: "Same claim",
        },
      ],
      "decider",
      () => {},
    );
    const merged = graph.findings.find((finding) => finding.id === target.id)!;
    assert.deepEqual(merged.traffic_ids, ["flow-a", "flow-b"], "captured flows follow the merged claim");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unattributed capture still matches inside the Step execution window", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-window-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Window match", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    const opened = new Date(Date.now() - 60_000).toISOString();
    const inside = new Date(Date.now() - 30_000).toISOString();
    // Transparent capture records no Step/Run: the flow must still be found by
    // the execution window and the Finding surface.
    store.traffic.ingest(id, [
      flow({
        id: "flow-inside",
        created_at: inside,
        method: "GET",
        url: "https://api.example.test/users/7",
        host: "api.example.test",
      }),
    ]);
    store.mutate(id, "seed-step", false, (graph) => {
      graph.steps.push({
        id: "s001",
        from: [],
        to: null,
        description: "Test the profile endpoint",
        priority: 1,
        discarded: false,
        creator: "test",
        worker: null,
        last_heartbeat_at: null,
        created_at: opened,
        executed_at: opened,
        concluded_at: null,
        fact_ids: [],
        summary: "",
        graph_id: "main",
        attempts: 0,
      });
    });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "IDOR on user profile",
        description: "Another user's profile was returned.",
        identity: { category: "access-control", method: "GET", host: "api.example.test", path: "/users/7" },
      }),
    );
    store.mutate(id, "seed-finding-step", false, (graph) => {
      graph.findings.find((item) => item.id === finding.id)!.step_id = "s001";
    });
    const matched = store.findingTraffic(id, finding.id);
    assert.equal(matched.source, "suggested");
    assert.deepEqual(
      matched.records.map((record) => record.id),
      ["flow-inside"],
    );

    // A flow captured after the Step concluded must not be matched.
    store.mutate(id, "close-step", false, (graph) => {
      graph.steps.find((step) => step.id === "s001")!.concluded_at = new Date(Date.now() - 10_000).toISOString();
    });
    const later = store.submitFinding(
      id,
      findingSchema.parse({
        title: "Later claim",
        description: "Nothing was captured for it.",
        identity: { category: "access-control", method: "GET", host: "api.example.test", path: "/users/9" },
      }),
    );
    assert.equal(store.findingTraffic(id, later.id).source, "none");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator confirmation pins and clears captured flows", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-finding-confirm-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Confirm links", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [flow({ id: "flow-a" }), flow({ id: "flow-b", url: "https://api.example.test/users/8" })]);
    const finding = store.submitFinding(
      id,
      findingSchema.parse({ title: "Uncited claim", description: "The executor cited no flow." }),
    );
    const confirmed = store.linkFindingTraffic(id, finding.id, ["flow-b", "flow-b", "flow-a"]);
    assert.equal(confirmed.source, "linked");
    assert.deepEqual(
      confirmed.records.map((record) => record.id),
      ["flow-b", "flow-a"],
      "order follows the reviewer's list and duplicates collapse",
    );
    assert.deepEqual(store.get(id).findings.find((item) => item.id === finding.id)!.traffic_ids, ["flow-b", "flow-a"]);

    const cleared = store.linkFindingTraffic(id, finding.id, []);
    assert.notEqual(cleared.source, "linked");
    assert.equal(store.get(id).findings.find((item) => item.id === finding.id)!.traffic_ids, undefined);

    assert.throws(
      () => store.linkFindingTraffic(id, finding.id, ["missing"]),
      (error: any) => error.statusCode === 422,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("traffic suggestions prefer the Finding surface inside the producing Step", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-traffic-suggest-")),
    store = new Store(join(dir, "graph.db"));
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Traffic suggestions", origin: "https://api.example.test", goal: "Assess" }),
    ).project.id;
    store.traffic.ingest(id, [
      flow({
        id: "flow-login",
        step_id: "s001",
        run_id: "run-1",
        method: "POST",
        url: "https://api.example.test/login",
        host: "api.example.test",
      }),
      flow({
        id: "flow-profile",
        step_id: "s001",
        run_id: "run-1",
        method: "GET",
        url: "https://api.example.test/users/7?view=full",
        host: "api.example.test",
        status: 200,
      }),
      flow({
        id: "flow-other-step",
        step_id: "s002",
        run_id: "run-2",
        method: "GET",
        url: "https://api.example.test/users/7",
      }),
    ]);

    const matched = store.traffic.suggest(id, "s001", "run-1", {
      method: "GET",
      host: "api.example.test",
      path: "/users/7",
    });
    assert.deepEqual(
      matched.map((record) => record.id),
      ["flow-profile"],
    );

    const runOnly = store.traffic.suggest(id, undefined, "run-2", null);
    assert.deepEqual(
      runOnly.map((record) => record.id),
      ["flow-other-step"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
