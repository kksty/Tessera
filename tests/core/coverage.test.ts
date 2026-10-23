import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import {
  coverageEntrySchema,
  createProjectSchema,
  decideSchema,
  executeSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { coverageSurfaces, normalizeSurface, validateCoverage } from "../../packages/protocol/src/coverage.js";
import { commitPlan } from "../helpers/current-api.js";

function submit(store: Store, id: string, worker: string, body: Record<string, unknown>) {
  const graph = store.get(id);
  return store.submitDecisions(
    id,
    submitDecisionsSchema.parse({
      ...body,
      submission_id: randomUUID(),
      worker,
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: graph.planning_revision,
    }),
  );
}

function observedProject() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Coverage", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const planner = store.claim(id, "planner", 0)!;
  commitPlan(
    store,
    id,
    decideSchema.parse({
      worker: planner.worker,
      revision: store.get(id).revision,
      observation_revision: store.get(id).observation_revision,
      planning_revision: store.get(id).planning_revision,
      steps: [{ from: ["origin"], description: "Probe the mailbox" }],
    }),
  );
  const executor = store.claim(id, "executor", 0)!;
  const evidence = store.addEvidence(id, {
    title: "mailbox response",
    content: "HTTP/1.1 200 OK",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  store.execute(
    id,
    executor.step_id!,
    executeSchema.parse({
      worker: executor.worker,
      summary: "probed",
      facts: [
        {
          description: "Mailbox detail and list endpoints observed",
          evidence_ids: [evidence.id],
          objects: [
            "https://example.test/detail.html?metadataId=1",
            "/IGI/nbhd/openGovmsgbox.do?method=listGovmsgboxs",
            "/workspace/evidence/raw.csv",
          ],
        },
      ],
    }),
  );
  return { store, id, evidence };
}

test("coverage surfaces normalize URLs and origin-relative paths, ignoring workspace files", () => {
  const { store, id } = observedProject();
  try {
    const surfaces = coverageSurfaces(store.get(id))
      .map((item) => item.surface)
      .sort();
    assert.deepEqual(surfaces, ["example.test/IGI/nbhd/openGovmsgbox.do", "example.test/detail.html"]);
    assert.equal(normalizeSurface("https://Example.TEST/detail.html?x=1", ""), "example.test/detail.html");
    assert.equal(normalizeSurface("/detail.html", "example.test"), "example.test/detail.html");
    assert.equal(normalizeSurface("/workspace/evidence/raw.csv", "example.test"), null);
    assert.equal(normalizeSurface("nginx", "example.test"), null);
    assert.equal(normalizeSurface("21/tcp", "example.test"), null, "port inventories are not hosts");
    assert.equal(normalizeSurface("8080/http", "example.test"), null);
    // Surfaces produced by the absolute-URL branch must be accepted again by
    // validation, including IPv6 literals and single-label internal hosts.
    assert.equal(normalizeSurface("https://[::1]:8443/admin", ""), "[::1]/admin");
    assert.equal(normalizeSurface("[::1]/admin", "", true), "[::1]/admin");
    assert.equal(normalizeSurface("https://localhost:9000/x", ""), "localhost/x");
    assert.equal(normalizeSurface("localhost/x", "", true), "localhost/x");
    assert.equal(normalizeSurface("localhost/x", ""), "localhost/x");
    assert.equal(normalizeSurface("nginx/1.2", ""), null);
  } finally {
    store.close();
  }
});

test("completion refuses to omit an observed surface and names it", () => {
  const { store, id, evidence } = observedProject();
  try {
    const planner = store.claim(id, "planner-2", 0)!;
    const step = store.get(id).steps[0];
    const close = { id: step.id, reason: "Probed", evidence_ids: [evidence.id], expected_version: step.version };
    const missing = submit(store, id, planner.worker, {
      closes: [close],
      complete: { from: ["origin"], description: "Search ended" },
    });
    assert.equal(missing.settle.ok, false);
    assert.match(missing.settle.conflicts[0].reason, /Coverage 未覆盖 2 个/);
    assert.match(missing.settle.conflicts[0].reason, /example\.test\/detail\.html/);
    assert.match(missing.settle.conflicts[0].reason, /openGovmsgbox\.do/);

    const partial = submit(store, id, planner.worker, {
      closes: [close],
      complete: {
        from: ["origin"],
        description: "Search ended",
        coverage: [{ surface: "/detail.html", status: "tested", evidence_ids: [evidence.id] }],
      },
    });
    assert.equal(partial.settle.ok, false);
    assert.match(partial.settle.conflicts[0].reason, /openGovmsgbox\.do/);
    assert.ok(!partial.settle.conflicts[0].reason.includes("detail.html"));

    const complete = submit(store, id, planner.worker, {
      closes: [close],
      complete: {
        from: ["origin"],
        description: "Search ended",
        coverage: [
          { surface: "https://example.test/detail.html", status: "tested", evidence_ids: [evidence.id] },
          {
            surface: "example.test/IGI/nbhd/openGovmsgbox.do",
            status: "waived",
            reason: "CORS-only endpoint; no object reference",
          },
        ],
      },
    });
    assert.equal(complete.settle.ok, true);
    const completed = store.get(id);
    assert.equal(completed.project.status, "completed");
    assert.equal(completed.project.pending_completion, undefined);
    const completion = completed.steps.find((step) => step.to === "goal");
    assert.ok(completion?.completion, "the accepted coverage is kept on the completion Step");
    assert.deepEqual(
      completion!.completion!.coverage.map((entry) => [entry.surface, entry.status]),
      [
        ["https://example.test/detail.html", "tested"],
        ["example.test/IGI/nbhd/openGovmsgbox.do", "waived"],
      ],
    );
    // The proposal's bookkeeping must not leak onto the Step as duplicate keys.
    assert.equal("observation_revision" in completion!, false);
  } finally {
    store.close();
  }
});

test("coverage status contract rejects tested without evidence and waived without reason", () => {
  assert.throws(() => coverageEntrySchema.parse({ surface: "/a", status: "tested" }), /evidence_ids/);
  assert.throws(() => coverageEntrySchema.parse({ surface: "/a", status: "waived" }), /reason/);
  assert.equal(coverageEntrySchema.parse({ surface: "/a", status: "na" }).status, "na");
});

test("validateCoverage tolerates unknown extra surfaces but rejects duplicates and bad evidence", () => {
  const { store, id } = observedProject();
  try {
    const graph = store.get(id);
    const check = validateCoverage(graph, [
      { surface: "example.test/detail.html", status: "tested", evidence_ids: [graph.evidence[0].id] },
      { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "tested", evidence_ids: [graph.evidence[0].id] },
      { surface: "example.test/extra", status: "na", evidence_ids: [] },
      { surface: "example.test/extra", status: "na", evidence_ids: [] },
      { surface: "example.test/bad-evidence", status: "tested", evidence_ids: ["e999"] },
    ]);
    assert.ok(check.missing.length === 0);
    assert.ok(check.invalid.some((value) => /重复/.test(value)));
    assert.ok(check.invalid.some((value) => /e999/.test(value)));

    // Per-parameter rows for one surface are not duplicates.
    const perParameter = validateCoverage(graph, [
      {
        surface: "example.test/detail.html",
        parameter: "metadataId",
        status: "tested",
        evidence_ids: [graph.evidence[0].id],
      },
      {
        surface: "example.test/detail.html",
        parameter: "siteId",
        status: "tested",
        evidence_ids: [graph.evidence[0].id],
      },
      { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "tested", evidence_ids: [graph.evidence[0].id] },
    ]);
    assert.deepEqual(perParameter.invalid, []);
    assert.deepEqual(perParameter.missing, []);
  } finally {
    store.close();
  }
});

test("coverage surfaces round-trip IPv6 and single-label hosts", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Hosts", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Probe", creator: "human", claim: true });
    const evidence = store.addEvidence(id, {
      title: "responses",
      content: "ok",
      encoding: "utf8",
      mime_type: "text/plain",
    });
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: "human",
        summary: "probed",
        facts: [
          {
            description: "Internal endpoints observed",
            evidence_ids: [evidence.id],
            objects: ["https://[::1]:8443/admin", "https://localhost:9000/x"],
          },
        ],
      }),
    );
    const graph = store.get(id);
    const surfaces = coverageSurfaces(graph).map((item) => item.surface);
    assert.deepEqual(surfaces, ["[::1]/admin", "localhost/x"]);
    const check = validateCoverage(
      graph,
      surfaces.map((surface) => ({ surface, status: "tested" as const, evidence_ids: [evidence.id] })),
    );
    assert.deepEqual(check.invalid, []);
    assert.deepEqual(check.missing, []);
  } finally {
    store.close();
  }
});
