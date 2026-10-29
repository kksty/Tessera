import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  executeSchema,
  factSubmissionSchema,
  findingSchema,
} from "../../packages/protocol/src/index.js";
import { recordReview } from "../helpers/current-api.js";

function fixture() {
  const store = new Store(":memory:");
  const id = store.create(
    createProjectSchema.parse({ title: "Negative", origin: "https://example.test", goal: "Assess" }),
  ).project.id;
  const step = store.manualStep(id, { from: ["origin"], description: "Probe absence", creator: "human", claim: true });
  const evidence = store.addEvidence(id, {
    title: "empty response",
    content: "totalCount: 0",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  return { store, id, step, evidence };
}

/**
 * Write a negative Fact straight into the graph, bypassing the write-time
 * provenance gate. These fixtures stand in for records imported or created
 * before that gate existed; the Review gate must still refuse them.
 */
function injectLegacyNegative(
  store: Store,
  id: string,
  step: { id: string },
  fact: Record<string, unknown>,
): { id: string } {
  return store.mutate(id, "fact.observed", true, (g) => {
    const numeric = g.facts.filter((value) => /^f\d+$/.test(value.id)).length + 1;
    const record: Record<string, unknown> = {
      id: `f${String(numeric).padStart(3, "0")}`,
      graph_id: "main",
      step_id: step.id,
      status: "not_observed",
      negative_claim_version: 1,
      created_at: new Date().toISOString(),
      evidence_ids: [],
      ...fact,
    };
    g.facts.push(record as never);
    g.steps.find((value) => value.id === step.id)!.fact_ids.push(String(record.id));
    return { id: String(record.id) };
  });
}

test("the fact contract carries the request and parameter provenance of a negative claim", () => {
  const parsed = factSubmissionSchema.parse({
    description: "GET /IGI/nbhd/openGovmsgbox.do with siteId=6400000100 returned totalCount 0",
    conclusion: "未发现公开信件数据",
    status: "not_observed",
    objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
    request: { method: "GET", url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=6400000100" },
    parameter_sources: [{ parameter: "siteId", source: "首页 meta SiteIDCode", evidence_ids: [] }],
    evidence_ids: [],
  });
  assert.equal(parsed.request?.method, "GET");
  assert.equal(parsed.parameter_sources?.[0].source, "首页 meta SiteIDCode");

  const { store, id, step, evidence } = fixture();
  try {
    const fact = store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker!,
        summary: "probed",
        facts: [
          {
            description: "Mailbox list returned totalCount 0",
            conclusion: "未发现公开信件数据",
            status: "not_observed",
            objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
            request: { method: "GET", url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=6400000100" },
            parameter_sources: [{ parameter: "siteId", source: "首页 meta SiteIDCode", evidence_ids: [evidence.id] }],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    ) as unknown as { facts: { id: string; request?: unknown; parameter_sources?: unknown[] }[] };
    const stored = store.get(id).facts.find((value) => value.id !== "origin")!;
    assert.deepEqual(stored.request, {
      method: "GET",
      url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=6400000100",
    });
    assert.equal(stored.parameter_sources?.length, 1);
    assert.ok(fact);
  } finally {
    store.close();
  }
});

test("a negative claim without provenance is rejected at write time and by Review", () => {
  const { store, id, step, evidence } = fixture();
  try {
    // Write-time gate: the executor sees the error while the request is in hand.
    assert.throws(
      () =>
        store.fact(id, step.id, {
          worker: step.worker!,
          description: "Mailbox list returned totalCount 0",
          conclusion: "未发现公开信件数据",
          status: "not_observed",
          objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
          evidence_ids: [evidence.id],
        }),
      /负向观测被拒绝.*request/,
    );
    // A record created before the gate (or imported) must still fail Review.
    const fact = injectLegacyNegative(store, id, step, {
      description: "Mailbox list returned totalCount 0",
      conclusion: "未发现公开信件数据",
      objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
      evidence_ids: [evidence.id],
    });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "公开统计接口无数据",
        description: "接口返回 totalCount 0",
        from: [fact.id],
        evidence_ids: [evidence.id],
      }),
    );
    assert.throws(
      () => recordReview(store, id, finding.id, "confirmed", "reviewer", "checked the response", "informational"),
      /Negative observation .* lacks request\/parameter_sources/,
    );
  } finally {
    store.close();
  }
});

test("Review names query parameters that have no provenance", () => {
  const { store, id, step, evidence } = fixture();
  try {
    const partial = {
      description: "Mailbox list returned totalCount 0",
      conclusion: "未发现公开信件数据",
      objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
      request: { method: "GET", url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=267&appID=128&metadataId=9" },
      parameter_sources: [{ parameter: "siteId", source: "页面 JS：var psiteId=267", evidence_ids: [evidence.id] }],
      evidence_ids: [evidence.id],
    };
    assert.throws(
      () => store.fact(id, step.id, { worker: step.worker!, status: "not_observed", ...partial }),
      /appID, metadataId/,
    );
    const fact = injectLegacyNegative(store, id, step, partial);
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "未发现数据",
        description: "使用真实 siteId 未发现数据",
        from: [fact.id],
        evidence_ids: [evidence.id],
      }),
    );
    assert.throws(
      () => recordReview(store, id, finding.id, "confirmed", "reviewer", "checked", "informational"),
      /appID, metadataId/,
    );
  } finally {
    store.close();
  }
});

test("Review matches an injected parameter name that itself contains an equals sign", () => {
  const { store, id, step, evidence } = fixture();
  try {
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker!,
        summary: "probed",
        facts: [
          {
            description: "The parameter-name payload was not reflected",
            conclusion: "参数名载荷未回显",
            status: "not_observed",
            objects: ["https://example.test/x"],
            request: {
              method: "GET",
              url: "https://example.test/x?companyID=1&%3Cscript%3Edocument.title%3D%27P1%27%3C%2Fscript%3E=1",
            },
            parameter_sources: [
              { parameter: "companyID", source: "列表页 AJAX data", evidence_ids: [evidence.id] },
              {
                parameter: "<script>document.title='P1'</script>",
                source: "测试构造的参数名载荷，页面不产生",
                evidence_ids: [evidence.id],
              },
            ],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const fact = store.get(id).facts.find((value) => value.id !== "origin")!;
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "参数名载荷未回显",
        description: "使用构造参数名复核",
        from: [fact.id],
        evidence_ids: [evidence.id],
      }),
    );
    const reviewed = recordReview(store, id, finding.id, "confirmed", "reviewer", "核对参数来源", "informational");
    assert.equal(reviewed.review_status, "pass");
  } finally {
    store.close();
  }
});

test("Review accepts name=value provenance entries when the name is a real request parameter", () => {
  const { store, id, step, evidence } = fixture();
  try {
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker!,
        summary: "probed",
        facts: [
          {
            description: "List returned no rows for the real identifiers",
            conclusion: "真实参数下无数据",
            status: "not_observed",
            objects: ["https://example.test/list"],
            request: { method: "GET", url: "https://example.test/list?siteId=267&appID=128" },
            parameter_sources: [
              { parameter: "siteId=267", source: "页面 JS：var psiteId=267", evidence_ids: [evidence.id] },
              { parameter: "appID=128", source: "页面 JS：applist appid 128", evidence_ids: [evidence.id] },
            ],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const fact = store.get(id).facts.find((value) => value.id !== "origin")!;
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "真实参数下无数据",
        description: "使用真实 siteId 与 appID 复核",
        from: [fact.id],
        evidence_ids: [evidence.id],
      }),
    );
    const reviewed = recordReview(store, id, finding.id, "confirmed", "reviewer", "核对参数来源", "informational");
    assert.equal(reviewed.review_status, "pass");
  } finally {
    store.close();
  }
});

test("legacy negative facts without the provenance marker remain reviewable", () => {
  const { store, id, evidence } = fixture();
  try {
    store.mutate(id, "", false, (graph) => {
      graph.facts.push({
        id: "f900",
        description: "Legacy negative observation",
        conclusion: "未发现公开数据",
        status: "not_observed",
        graph_id: "main",
        evidence_ids: [evidence.id],
        created_at: new Date().toISOString(),
      });
    });
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "历史负面结论",
        description: "历史记录",
        from: ["f900"],
        evidence_ids: [evidence.id],
      }),
    );
    const reviewed = recordReview(store, id, finding.id, "confirmed", "reviewer", "legacy fact", "informational");
    assert.equal(reviewed.review_status, "pass");
  } finally {
    store.close();
  }
});

test("an unrelated negative Step fact does not block a Finding that does not reference it", () => {
  const { store, id, step, evidence } = fixture();
  try {
    // Same Step produces a negative observation on an unrelated endpoint...
    injectLegacyNegative(store, id, step, {
      description: "Unrelated endpoint returned no rows",
      conclusion: "无关端点未返回数据",
      objects: ["https://example.test/unrelated"],
      evidence_ids: [evidence.id],
    });
    // ...and the real observation the Finding is built on.
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker!,
        summary: "probed two independent questions",
        facts: [
          {
            description: "The reported endpoint reflected the parameter",
            conclusion: "目标端点回显参数",
            status: "observed",
            objects: ["https://example.test/target"],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const facts = store.get(id).facts.filter((value) => value.id !== "origin");
    const observed = facts.find((value) => value.status === "observed")!;
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "目标端点回显参数",
        description: "只引用本 Finding 实际使用的观测",
        from: [observed.id],
        evidence_ids: [evidence.id],
      }),
    );
    const reviewed = recordReview(store, id, finding.id, "confirmed", "reviewer", "核对目标观测", "informational");
    assert.equal(reviewed.review_status, "pass");
  } finally {
    store.close();
  }
});

test("Review can pass a negative claim that records the request and parameter sources", () => {
  const { store, id, step, evidence } = fixture();
  try {
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker!,
        summary: "probed",
        facts: [
          {
            description: "Mailbox list with the site id from page JS returned totalCount 0",
            conclusion: "使用页面真实 siteId 未发现公开信件",
            status: "not_observed",
            objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
            request: { method: "GET", url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=267&appID=128" },
            parameter_sources: [
              { parameter: "siteId", source: "hdjl 页面 JS：var psiteId=267", evidence_ids: [evidence.id] },
              { parameter: "appID", source: "hdjl 页面 JS：applist appid 128", evidence_ids: [evidence.id] },
            ],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const fact = store.get(id).facts.find((value) => value.id !== "origin")!;
    const finding = store.submitFinding(
      id,
      findingSchema.parse({
        title: "真实参数下无公开数据",
        description: "使用页面真实参数复核",
        from: [fact.id],
        evidence_ids: [evidence.id],
      }),
    );
    const reviewed = recordReview(
      store,
      id,
      finding.id,
      "confirmed",
      "reviewer",
      "记下了请求和参数来源",
      "informational",
    );
    assert.equal(reviewed.review_status, "pass");
  } finally {
    store.close();
  }
});
