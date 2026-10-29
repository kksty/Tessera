import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  submitDecisionsSchema,
} from "../../packages/protocol/src/index.js";
import { memoryEntry, queryMemory } from "../../packages/core/src/memory.js";
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

function executedLeadProject() {
  const store = new Store(":memory:");
  const id = store.create(createProjectSchema.parse({ title: "Leads", origin: "https://example.test", goal: "Assess" }))
    .project.id;
  const planner = store.claim(id, "planner", 0)!;
  commitPlan(
    store,
    id,
    decideSchema.parse({
      worker: planner.worker,
      revision: store.get(id).revision,
      observation_revision: store.get(id).observation_revision,
      planning_revision: store.get(id).planning_revision,
      steps: [
        {
          from: ["origin"],
          description: "Read the mailbox page",
          property: "信件列表只返回当前站点公开数据",
          method_hint: "先读页面 JS 找真实 siteId",
        },
      ],
    }),
  );
  const executor = store.claim(id, "executor", 0)!;
  const evidence = store.addEvidence(id, {
    title: "page JS",
    content: "var psiteId=267;",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  store.execute(
    id,
    executor.step_id!,
    executeSchema.parse({
      worker: executor.worker,
      summary: "page read",
      facts: [{ description: "Page JS exposes the real siteId", objects: ["/hdjl/"], evidence_ids: [evidence.id] }],
      leads: [
        {
          surface: "/IGI/nbhd/openGovmsgbox.do",
          parameter: "siteId",
          why: "真实 siteId 可能返回他人信件",
          suggested_property: "viewGovmsgbox 不校验 metadataId 归属",
          evidence_ids: [evidence.id],
        },
      ],
    }),
  );
  return { store, id, evidence };
}

test("execution leads and step properties enter the Decide view", () => {
  const { store, id } = executedLeadProject();
  try {
    const graph = store.get(id);
    assert.equal(graph.steps[0].property, "信件列表只返回当前站点公开数据");
    assert.equal(graph.leads?.[0].status, "open");
    const job = store.claim(id, "planner-2", 0)!;
    assert.equal(job.kind, "decide");
    const view = memoryEntry(graph, job) as any;
    assert.match(view.leads[0], /l001 open example\.test\/IGI\/nbhd\/openGovmsgbox\.do/);
    assert.match(view.leads[0], /siteId/);
    assert.match(view.steps[0], /属性：信件列表只返回当前站点公开数据/);
    assert.match(view.steps[0], /方法建议：先读页面 JS 找真实 siteId/);
    assert.match(view.coverage_surfaces[0].surface, /example\.test\/hdjl/);
    const executeView = memoryEntry(graph, {
      kind: "execute",
      project_id: id,
      graph_id: "main",
      worker: "viewer",
      step_id: graph.steps[0].id,
    } as any) as any;
    assert.equal(executeView.focus.property, "信件列表只返回当前站点公开数据");
    assert.equal(executeView.focus.method_hint, "先读页面 JS 找真实 siteId");
    const page = queryMemory(graph, { kind: "leads" });
    assert.equal(page.items[0].id, "l001");
    assert.match(page.items[0].preview, /openGovmsgbox/);
    assert.match(page.items[0].preview, /真实 siteId 可能返回他人信件/);
    const changes = store.memoryChanges(id, { after_revision: 0, through_revision: graph.revision, limit: 100 });
    const leadChange = changes.items.find((item) => item.kind === "leads");
    assert.ok(leadChange);
    assert.match(leadChange.preview, /openGovmsgbox/);
  } finally {
    store.close();
  }
});

test("an open lead is advisory: completion succeeds and the lead stays on the board", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const planner = store.claim(id, "planner-2", 0)!;
    const step = store.get(id).steps[0];
    const close = { id: step.id, reason: "Page read", evidence_ids: [evidence.id], expected_version: step.version };
    const completed = submit(store, id, planner.worker, {
      closes: [close],
      complete: {
        from: ["origin"],
        description: "Done",
        coverage: [
          { surface: "example.test/hdjl/", status: "tested", evidence_ids: [evidence.id] },
          { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "tested", evidence_ids: [evidence.id] },
        ],
      },
    });
    assert.equal(completed.settle.ok, true, JSON.stringify(completed.settle.conflicts));
    assert.equal(completed.settle.completed, true);
    assert.equal(store.get(id).project.status, "completed");
    // Leaving an unexamined suggestion is allowed; it is not a hidden obligation.
    assert.equal(store.get(id).leads?.[0].status, "open");
  } finally {
    store.close();
  }
});

test("a Step can still carry an open lead into follow-up work", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const planner = store.claim(id, "planner-2", 0)!;
    const step = store.get(id).steps[0];
    const close = { id: step.id, reason: "Page read", evidence_ids: [evidence.id], expected_version: step.version };
    const planned = submit(store, id, planner.worker, {
      closes: [close],
      steps: [
        {
          from: ["origin"],
          description: "Test the mailbox object reference",
          property: "伪造 metadataId 不能读取他人信件",
          lead_ids: ["l001"],
        },
      ],
    });
    assert.equal(planned.settle.ok, true, JSON.stringify(planned.settle.conflicts));
    let graph = store.get(id);
    assert.equal(graph.leads?.[0].status, "converted");
    assert.equal(graph.leads?.[0].converted_step_id, graph.steps[1].id);

    const followUp = graph.steps[1];
    store.closeStep(id, followUp.id, {
      worker: "human",
      reason: "Answered",
      evidence_ids: [evidence.id],
      expected_version: followUp.version,
    });
    const next = store.claim(id, "planner-3", 0)!;
    const completed = submit(store, id, next.worker, {
      complete: {
        from: ["origin"],
        description: "Done",
        coverage: [
          { surface: "example.test/hdjl/", status: "tested", evidence_ids: [evidence.id] },
          { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "tested", evidence_ids: [evidence.id] },
        ],
      },
    });
    assert.equal(completed.settle.ok, true, JSON.stringify(completed.settle.conflicts));
    assert.equal(store.get(id).project.status, "completed");
  } finally {
    store.close();
  }
});

test("a lead attached to a Step discarded in the same settlement goes back to open", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const extra = store.manualStep(id, { from: ["origin"], description: "noise", creator: "human" });
    const planner = store.claim(id, "planner-2", 0)!;
    const step = store.get(id).steps[0];
    const settled = submit(store, id, planner.worker, {
      closes: [{ id: step.id, reason: "Page read", evidence_ids: [evidence.id], expected_version: step.version }],
      updates: [{ id: extra.id, discard: true, reason: "noise", expected_version: extra.version }],
      // The Step named for this lead is discarded by the same batch; the lead
      // must not be left invisibly "converted" to work that never happened.
      lead_dispositions: [{ lead_id: "l001", step_id: extra.id }],
      complete: {
        from: ["origin"],
        description: "Done",
        coverage: [
          { surface: "example.test/hdjl/", status: "tested", evidence_ids: [evidence.id] },
          { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "waived", reason: "not tested" },
        ],
      },
    });
    assert.equal(settled.settle.ok, true, JSON.stringify(settled.settle.conflicts));
    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.leads?.[0].status, "open");
    assert.equal(graph.leads?.[0].converted_step_id, undefined);
  } finally {
    store.close();
  }
});

test("a waiver can retire a converted lead in the settlement that discards its Step", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const close = (() => {
      const step = store.get(id).steps[0];
      return { id: step.id, reason: "Page read", evidence_ids: [evidence.id], expected_version: step.version };
    })();
    const planner = store.claim(id, "planner-2", 0)!;
    const planned = submit(store, id, planner.worker, {
      closes: [close],
      steps: [
        {
          from: ["origin"],
          description: "Test the mailbox object reference",
          property: "伪造 metadataId 不能读取他人信件",
          lead_ids: ["l001"],
        },
      ],
    });
    assert.equal(planned.settle.ok, true);
    const followUp = store.get(id).steps[1];
    assert.equal(store.get(id).leads?.[0].status, "converted");

    // A new manual Step advances planning so the next claim is a Decide lease.
    const noise = store.manualStep(id, { from: ["origin"], description: "noise", creator: "human" });
    const next = store.claim(id, "planner-3", 0)!;
    assert.equal(next.kind, "decide");
    const retried = submit(store, id, next.worker, {
      updates: [
        { id: followUp.id, discard: true, reason: "stop", expected_version: followUp.version },
        { id: noise.id, discard: true, reason: "noise", expected_version: noise.version },
      ],
      lead_dispositions: [{ lead_id: "l001", waiver_reason: "不再追究" }],
      complete: {
        from: ["origin"],
        description: "Done",
        coverage: [
          { surface: "example.test/hdjl/", status: "tested", evidence_ids: [evidence.id] },
          { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "waived", reason: "not tested" },
        ],
      },
    });
    assert.equal(retried.settle.ok, true);
    const graph = store.get(id);
    assert.equal(graph.project.status, "completed");
    assert.equal(graph.leads?.[0].status, "waived");
    assert.match(graph.leads?.[0].waiver_reason ?? "", /不再追究/);
  } finally {
    store.close();
  }
});

test("retiring a Step outside Decide reopens the leads it had converted", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    store.hint(id, "Check the mailbox through the real site id");
    const planner = store.claim(id, "planner-2", 0)!;
    const step = store.get(id).steps[0];
    const planned = submit(store, id, planner.worker, {
      closes: [{ id: step.id, reason: "Page read", evidence_ids: [evidence.id], expected_version: step.version }],
      steps: [
        {
          from: ["origin"],
          description: "Test the mailbox object reference",
          property: "伪造 metadataId 不能读取他人信件",
          lead_ids: ["l001"],
          hint_ids: ["h001"],
        },
      ],
    });
    assert.equal(planned.settle.ok, true);
    assert.equal(store.get(id).leads?.[0].status, "converted");

    // Withdrawing the Hint cancels its Step. That Step can no longer answer the
    // lead, so the lead must return to the open list and become actionable.
    store.updateHint(id, "h001", {}, true);
    const graph = store.get(id);
    assert.equal(graph.steps[1].discarded, true);
    assert.equal(graph.leads?.[0].status, "open");
    assert.equal(graph.leads?.[0].converted_step_id, undefined);
    const job = store.claim(id, "planner-3", 0)!;
    const view = memoryEntry(graph, job) as any;
    assert.ok(view.leads.some((line: string) => /l001 open/.test(line)));
  } finally {
    store.close();
  }
});

test("a relative lead belongs to the Step's asset rather than the project origin", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Asset leads", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    store.discover(id, [{ hostname: "api.example.test", source: "seed", evidence_ids: [] }]);
    const asset = store.get(id).assets.find((value) => value.hostname === "api.example.test")!;
    store.approve(id, [asset.id]);
    const step = store.manualStep(id, {
      from: ["origin"],
      description: "Probe the API",
      asset_id: asset.id,
      creator: "human",
      claim: true,
    });
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: "human",
        summary: "probed",
        leads: [
          {
            surface: "/admin",
            parameter: "role",
            why: "the API exposes an admin route",
            suggested_property: "an unprivileged caller cannot use the admin route",
          },
        ],
      }),
    );
    assert.equal(store.get(id).leads?.[0].surface, "api.example.test/admin");
  } finally {
    store.close();
  }
});

test("a lead cannot be assigned to a Step that was already discarded", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const step = store.get(id).steps[0];
    store.updateStep(id, step.id, { discard: true, reason: "wrong direction", expected_version: step.version });
    const planner = store.claim(id, "planner-2", 0)!;
    const blocked = submit(store, id, planner.worker, {
      lead_dispositions: [{ lead_id: "l001", step_id: step.id }],
      complete: {
        from: ["origin"],
        description: "Done",
        coverage: [
          { surface: "example.test/hdjl/", status: "tested", evidence_ids: [evidence.id] },
          { surface: "example.test/IGI/nbhd/openGovmsgbox.do", status: "waived", reason: "not tested" },
        ],
      },
    });
    assert.equal(blocked.settle.ok, false);
    assert.ok(blocked.settle.conflicts.some((conflict) => /already discarded/.test(conflict.reason)));
    assert.equal(store.get(id).leads?.[0].status, "open");
  } finally {
    store.close();
  }
});

test("read-only recovery cannot smuggle new leads", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(
      createProjectSchema.parse({ title: "Read only", origin: "https://example.test", goal: "Assess" }),
    ).project.id;
    const step = store.manualStep(id, { from: ["origin"], description: "Recover", creator: "human", claim: true });
    assert.throws(
      () =>
        store.execute(
          id,
          step.id,
          executeSchema.parse({
            worker: "human",
            summary: "seen",
            read_only: true,
            leads: [{ surface: "/login", why: "worth testing", suggested_property: "no bypass" }],
          }),
        ),
      /Read-only recovery cannot submit new observations/,
    );
    assert.equal(store.get(id).leads?.length ?? 0, 0);
  } finally {
    store.close();
  }
});

test("duplicate open leads merge evidence and keep one completion item", () => {
  const { store, id, evidence } = executedLeadProject();
  try {
    const second = store.manualStep(id, {
      from: ["origin"],
      description: "Probe again",
      creator: "human",
      claim: true,
    });
    store.execute(
      id,
      second.id,
      executeSchema.parse({
        worker: "human",
        summary: "again",
        leads: [
          {
            surface: "https://example.test/IGI/nbhd/openGovmsgbox.do?x=1",
            parameter: "siteId",
            why: "duplicate",
            suggested_property: "same",
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const leads = store.get(id).leads ?? [];
    assert.equal(leads.length, 1);
    assert.ok(leads[0].evidence_ids.includes(evidence.id));
  } finally {
    store.close();
  }
});
