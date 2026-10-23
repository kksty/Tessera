import { recordReview } from "../helpers/current-api.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, DomainError } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { reportView } from "../../packages/core/src/report-view.js";
import { fence, inline, paragraph, reproductionBlocks } from "../../packages/core/src/report-text.js";
import { digest } from "../../packages/core/src/execution.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import { createProjectSchema, findingSchema, reviewSchema, submitDecisionsSchema } from "../../packages/protocol/src/index.js";
import { missingReportFields } from "../../packages/protocol/src/report-quality.js";
import { reportFields, reportSnapshot } from "../fixtures/report.js";
import { cvss } from "../fixtures/cvss.js";
import { deferDecideMs } from "../helpers/scheduling.js";

test("complete and empty reports match reviewed Markdown golden files", () => {
  const store = new Store(":memory:");
  try {
    const reports = new Reports(store);
    for (const [name, empty] of [["complete", false], ["empty", true]] as const) {
      const snapshot = reportSnapshot(empty), before = structuredClone(snapshot);
      assert.equal(reports.markdown(snapshot), readFileSync(new URL(`../fixtures/reports/${name}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
      assert.deepEqual(snapshot, before, "presentation cannot mutate frozen material");
    }
  } finally { store.close(); }
});

test("free text cannot introduce Markdown blocks, links, HTML or decoded entities", () => {
  const corpus = ["## 标题", "| a | b |", "```", "~~~~", "[x](javascript:alert(1))", "<b>伪造</b>", "1. 列表", "1) 列表", "> 引用", "- 列表", "+ 列表", "---", "===", "    缩进代码", "\t缩进代码", "\\**粗体**", "&lt;script&gt;"];
  for (const text of corpus) {
    const rendered = paragraph(text);
    assert.doesNotMatch(rendered, /^(?:\s{4}|\t|#{1,6}\s|>|[-+*]\s|\d{1,9}[.)]\s|\||`{3,}|~{3,}|<|[-=]{3,}$)/m, text);
    assert.doesNotMatch(rendered, /(?<!\\)\[x\]\(|(?<!\\)<b>|&lt;script/, text);
  }
  assert.equal(paragraph("第一行\r\n第二行\n \n## 后段"), "第一行 第二行\n\n\\#\\# 后段");
  assert.equal(paragraph("1. 列表"), "1\\. 列表", "escape punctuation rather than displaying a backslash before the digit");
  assert.equal(inline("[x](y)\n<b>"), "\\[x\\]\\(y\\) \\<b\\>");
  const store = new Store(":memory:");
  try {
    const snapshot = reportSnapshot(), attack = "\n\n## 伪造章节\n\n[x](y)\n\n<script>";
    Object.assign(snapshot.material.findings[0], { title: attack, description: attack, impact: attack, remediation: attack, severity_reason: attack,
      reproduction: { conditions: [attack], steps: [attack], expected: attack, observed: attack } });
    snapshot.material.goal = attack; snapshot.material.origin = attack;
    snapshot.material.project.title = attack; snapshot.material.reviews[0].reason = attack; snapshot.material.evidence[0].title = attack;
    const markdown = new Reports(store).markdown(snapshot);
    assert.doesNotMatch(markdown, /^## 伪造章节|(?<!\\)\[x\]\(y\)|<script>/m);
    assert.ok(markdown.includes("\\#\\# 伪造章节"));
  } finally { store.close(); }
});

test("evidence and HTTP request fences preserve raw lines and cannot close early", () => {
  const raw = "GET / HTTP/1.1\r\nHost: test\r\n\r\n```\r\n````\r\n<script>\r\n\r\n";
  assert.equal(fence(raw), "`````text\n" + raw.replace(/\r\n/g, "\n") + "`````");
  const blocks = reproductionBlocks(["1. 说明", "2. curl https://example.test", "3. -H 'X-Test: value'", "--data '{\"key\":1}'", "4. 核对响应"]);
  assert.deepEqual(blocks, [{ kind: "step", text: "说明" }, { kind: "request", text: "curl https://example.test\n-H 'X-Test: value'\n--data '{\"key\":1}'" }, { kind: "step", text: "核对响应" }]);
  const store = new Store(":memory:");
  try {
    const snapshot = reportSnapshot(); snapshot.material.findings[0].evidence = raw;
    snapshot.material.findings[0].identity!.path = "/```/";
    snapshot.material.findings[0].reproduction!.steps = ["GET / HTTP/1.1\nHost: test\n\n```\n## literal"];
    const markdown = new Reports(store).markdown(snapshot);
    assert.ok(markdown.includes(fence(raw)));
    assert.ok(markdown.includes("````http\nGET / HTTP/1.1\nHost: test\n\n```\n## literal\n````"));
    assert.ok(markdown.includes(snapshot.material.evidence[0].sha256));
    assert.ok(markdown.includes("````json\n"), "identity values also require adaptive fences");
  } finally { store.close(); }
});

test("legacy report readiness is derived without changing source hashes, records or inclusion", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Legacy report", origin: "https://example.test", goal: "Assess" })).project.id;
    const proof = store.addEvidence(id, { title: "Proof", content: "raw", mime_type: "text/plain", encoding: "utf8" });
    const finding = store.submitFinding(id, findingSchema.parse({ ...reportFields, title: "Legacy claim", description: "Details", evidence_ids: [proof.id], cvss: cvss.high }));
    recordReview(store, id, finding.id, "confirmed", "human", "Checked", "vulnerability");
    store.mutate(id, "fixture.legacy", false, graph => {
      const f = graph.findings[0]; delete f.impact; delete f.reproduction; delete f.remediation;
    });
    const reports = new Reports(store), snapshot = reports.create(id), frozen = reports.get(id, snapshot.id), graph = store.get(id);
    assert.equal(snapshot.source_hash, digest(reportMaterial(graph)));
    assert.equal(reports.list(id)[0].incomplete_count, 1);
    assert.equal(reports.list(id)[0].stale, false);
    assert.equal(reportView(snapshot.material).summary.incomplete, 1);
    assert.match(reports.markdown(snapshot), /缺少：影响描述 \/ 复现步骤 \/ 修复建议/);
    assert.deepEqual(reports.get(id, snapshot.id), frozen);
    assert.deepEqual(store.get(id), graph);
    assert.equal(reports.create(id).id, snapshot.id);
  } finally { store.close(); }
});

test("new automatic and manual vulnerability confirmations reject every missing report field atomically", () => {
  for (const changes of [{ impact: null }, { reproduction: null }, { reproduction: { conditions: [], steps: [] } }, { remediation: "   " }, { reproduction: { conditions: [], steps: ["  "] } }]) {
    const store = new Store(":memory:");
    try {
      const id = store.create(createProjectSchema.parse({ title: "Gate", origin: "https://example.test", goal: "Assess" })).project.id;
      const proof = store.addEvidence(id, { title: "Proof", content: "raw", mime_type: "text/plain", encoding: "utf8" });
      const finding = store.submitFinding(id, findingSchema.parse({ ...reportFields, title: "Claim", description: "Details", evidence_ids: [proof.id], cvss: cvss.high }));
      store.mutate(id, "fixture.missing", false, graph => Object.assign(graph.findings[0], changes));
      const reviewer = store.claim(id, "reviewer", deferDecideMs)!, before = store.get(id);
      const check = (error: unknown) => error instanceof DomainError && error.statusCode === 422 && /report fields/.test(error.message);
      assert.throws(() => store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: reviewer.worker, finding_version: 1, verdict: "pass", reason: "Checked", cvss: cvss.high })), check);
      assert.deepEqual(store.get(id), before, "rejected pass cannot clear a lease or change a rating");
      assert.throws(() => recordReview(store, id, finding.id, "confirmed", "human", "Checked", "vulnerability"), check);
      assert.deepEqual(store.get(id), before);
      assert.ok(missingReportFields(before.findings[0]).length);
      store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: reviewer.worker, finding_version: 1, verdict: "needs_evidence", reason: "Report fields need revision" }));
      assert.equal(store.get(id).findings[0].review_status, "needs_evidence");
    } finally { store.close(); }
  }
});

test("Decide repairs missing content with finding_updates and the new version can pass re-review", () => {
  const store = new Store(":memory:");
  try {
    const id = store.create(createProjectSchema.parse({ title: "Repair", origin: "https://example.test", goal: "Assess" })).project.id;
    const proof = store.addEvidence(id, { title: "Proof", content: "raw", mime_type: "text/plain", encoding: "utf8" });
    const finding = store.submitFinding(id, findingSchema.parse({ title: "Thin claim", description: "Details", evidence_ids: [proof.id] }));
    const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: reviewer.worker, finding_version: 1, verdict: "needs_evidence", reason: "Missing report fields: impact, reproduction.steps, remediation" }));
    const planner = store.claim(id, "planner", 0)!, graph = store.get(id);
    const result = store.submitDecisions(id, submitDecisionsSchema.parse({ worker: planner.worker, submission_id: "repair-report", revision: graph.revision,
      observation_revision: graph.observation_revision, planning_revision: graph.planning_revision,
      finding_updates: [{ id: finding.id, expected_version: 1, reason: "Summarize existing proof", changes: reportFields }] }));
    assert.equal(result.settle.ok, true);
    const next = store.claim(id, "reviewer-v2", deferDecideMs)!;
    assert.equal(next.finding_version, 2);
    store.review(id, finding.id, reviewSchema.parse({ kind: "vulnerability", worker: next.worker, finding_version: 2, verdict: "pass", reason: "Report content and original evidence checked", cvss: cvss.high }));
    assert.equal(new Reports(store).create(id).material.findings[0].version, 2);
  } finally { store.close(); }
});
