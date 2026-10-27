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
