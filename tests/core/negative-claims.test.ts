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
        worker: step.worker,
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

test("Review refuses to pass a negative claim without parameter provenance", () => {
  const { store, id, step, evidence } = fixture();
  try {
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker,
        summary: "probed",
        facts: [
          {
            description: "Mailbox list returned totalCount 0",
            conclusion: "未发现公开信件数据",
            status: "not_observed",
            objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
            evidence_ids: [evidence.id],
          },
        ],
      }),
    );
    const fact = store.get(id).facts.find((value) => value.id !== "origin")!;
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
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker,
        summary: "probed",
        facts: [
          {
            description: "Mailbox list returned totalCount 0",
            conclusion: "未发现公开信件数据",
            status: "not_observed",
            objects: ["https://example.test/IGI/nbhd/openGovmsgbox.do"],
            request: {
              method: "GET",
              url: "https://example.test/IGI/nbhd/openGovmsgbox.do?siteId=267&appID=128&metadataId=9",
            },
            parameter_sources: [
              { parameter: "siteId", source: "页面 JS：var psiteId=267", evidence_ids: [evidence.id] },
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

test("Review can pass a negative claim that records the request and parameter sources", () => {
  const { store, id, step, evidence } = fixture();
  try {
    store.execute(
      id,
      step.id,
      executeSchema.parse({
        worker: step.worker,
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
