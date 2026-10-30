import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, DomainError } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { reportMaterial } from "../../packages/core/src/report-material.js";
import { memoryEntry } from "../../packages/core/src/memory.js";
import {
  createProjectSchema,
  findingSchema,
  reviewSchema,
  executeSchema,
  confirmedVulnerability,
} from "../../packages/protocol/src/index.js";
import { reviewGate } from "../../packages/protocol/src/review-scheduling.js";
import { reportFields } from "../fixtures/report.js";
import { cvss, withImpactEvidence } from "../fixtures/cvss.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture(reviewed = true) {
  const store = new Store(":memory:"),
    reports = new Reports(store);
  const id = store.create(
    createProjectSchema.parse({ title: "人工处理", origin: "https://example.test", goal: "验证记录访问边界" }),
  ).project.id;
  const evidence = store.addEvidence(id, {
    title: "原始响应",
    content: "original proof",
    mime_type: "text/plain",
    encoding: "utf8",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      ...reportFields,
      title: "记录越权",
      description: "已观测影响",
      from: ["origin"],
      evidence_ids: [evidence.id],
      identity: { category: "access_control", host: "example.test", path: "/records" },
    }),
  );
  if (reviewed) {
    const job = store.claim(id, "reviewer", deferDecideMs)!;
    store.review(
      id,
      finding.id,
      reviewSchema.parse({
        worker: job.worker,
        finding_version: 1,
        kind: "vulnerability",
        verdict: "pass",
        reason: "原始证据核对完成",
        cvss: cvss.high,
      }),
    );
  }
  const action = (action: "delete" | "return" | "retest", version = store.get(id).findings[0].version) =>
    store.findingAction(id, finding.id, {
      action,
      expected_version: version,
      creator: "operator",
      reason: "核对修复后的跨账号访问行为",
    });
  return { store, reports, id, finding, evidence, action };
}

test("已入库漏洞可打回；旧审核失效，说明进入 Decide 且报告标记过期", () => {
  const f = fixture();
  try {
    const snapshot = f.reports.create(f.id),
      updated = f.action("return"),
      graph = f.store.get(f.id);
    assert.equal(updated.version, 2);
    assert.equal(updated.review_status, "needs_evidence");
    assert.equal(updated.cvss, null);
    assert.equal(confirmedVulnerability(updated, graph), false);
    assert.equal(f.store.allFindings().filter((f) => f.confirmed).length, 0);
    assert.equal(f.reports.list(f.id)[0].stale, true);
    assert.equal(f.reports.get(f.id, snapshot.id).material.findings.length, 1);
    assert.equal(graph.reviews[0].verdict, "pass");
    assert.equal(graph.reviews.at(-1)!.source, "human");
    const job = f.store.claim(f.id, "planner", 0)!;
    assert.equal(job.kind, "decide");
    assert.ok(JSON.stringify(memoryEntry(f.store.get(f.id), job)).includes("核对修复后的跨账号访问行为"));
  } finally {
    f.store.close();
  }
});

test("人工操作拒绝未审核发现及过期版本，且取消在途 Review 防止迟到结果覆盖", () => {
  const f = fixture(false);
  try {
    const before = f.store.get(f.id);
    assert.throws(() => f.action("delete"), /经过 Review/);
    assert.deepEqual(f.store.get(f.id), before);
    const reviewer = f.store.claim(f.id, "reviewer", deferDecideMs)!;
    f.store.review(
      f.id,
      f.finding.id,
      reviewSchema.parse({
        worker: reviewer.worker,
        finding_version: 1,
        kind: "vulnerability",
        verdict: "pass",
        reason: "Checked",
        cvss: cvss.high,
      }),
    );
    f.store.reviseFinding(f.id, f.finding.id, { description: "New assessment" });
    const next = f.store.claim(f.id, "reviewer-v2", deferDecideMs)!;
    assert.throws(() => f.action("return", 1), /版本已更新/);
    f.action("return", 2);
    assert.equal(f.store.runs(f.id).find((run) => run.id === next.run_id)!.status, "cancelled");
    assert.throws(
      () =>
        f.store.review(
          f.id,
          f.finding.id,
          reviewSchema.parse({
            worker: next.worker,
            finding_version: 2,
            kind: "vulnerability",
            verdict: "pass",
            reason: "Late",
            cvss: cvss.high,
          }),
        ),
      /lease|changed/,
    );
  } finally {
    f.store.close();
  }
});

test("删除退出当前交付并保留原始证据；同身份不能重新创建以绕过人工删除", () => {
  const f = fixture();
  try {
    const frozen = f.reports.create(f.id);
    f.action("delete");
    const graph = f.store.get(f.id);
    assert.equal(graph.findings[0].deleted!.by, "operator");
    assert.equal(reportMaterial(graph).findings.length, 0);
    assert.equal(f.store.evidenceContent(f.id, f.evidence.id).bytes.toString(), "original proof");
    assert.equal(f.reports.get(f.id, frozen.id).material.findings[0].id, f.finding.id);
    assert.throws(() => f.action("delete"), /已删除/);
    assert.throws(
      () =>
        f.store.submitFinding(
          f.id,
          findingSchema.parse({
            ...reportFields,
            title: "重新包装",
            description: "same",
            identity: f.finding.identity,
          }),
        ),
      /deleted by the operator/,
    );
  } finally {
    f.store.close();
  }
});

test("带说明的重测先执行，再将原漏洞新版本和新证据交 Review；旧证据不能直接通过", () => {
  for (const fresh of [true, false]) {
    const f = fixture();
    try {
      f.action("retest");
      let graph = f.store.get(f.id),
        finding = graph.findings[0],
        step = graph.steps.find((s) => s.id === finding.human_feedback!.step_id)!;
      assert.match(step.description, /核对修复后的跨账号访问行为/);
      assert.equal(step.retest_finding_id, finding.id);
      assert.equal(reviewGate(graph, finding), "current");
      f.store.manualHeartbeat(f.id, step.id, "executor");
      const proof = fresh
        ? f.store.addEvidence(f.id, {
            title: "重测响应",
            content: "new proof",
            mime_type: "text/plain",
            encoding: "utf8",
          })
        : f.evidence;
      f.store.execute(
        f.id,
        step.id,
        executeSchema.parse({
          worker: "executor",
          facts: [
            { description: "重测结果", conclusion: "重测响应已保存", status: "observed", evidence_ids: [proof.id] },
          ],
          summary: "重测完成",
        }),
      );
      graph = f.store.get(f.id);
      finding = graph.findings[0];
      assert.equal(graph.findings.length, 1);
      assert.equal(finding.id, f.finding.id);
      assert.equal(finding.version, 3);
      const job = f.store.claim(f.id, "retest-reviewer", deferDecideMs)!;
      assert.equal(job.kind, "review");
      const submit = () =>
        f.store.review(
          f.id,
          finding.id,
          reviewSchema.parse({
            worker: job.worker,
            finding_version: finding.version,
            kind: "vulnerability",
            verdict: "pass",
            reason: "重测证据核查完成",
            cvss: withImpactEvidence(cvss.high, [proof.id]),
          }),
        );
      if (fresh) {
        submit();
        assert.equal(confirmedVulnerability(f.store.get(f.id).findings[0]), true);
      } else
        assert.throws(
          submit,
          (error) => error instanceof DomainError && error.statusCode === 422 && /新原始证据/.test(error.message),
        );
    } finally {
      f.store.close();
    }
  }
});

test("已完成项目可由重测重新打开，暂停项目保留暂停，资产撤权则原子拒绝重测", () => {
  for (const status of ["completed", "stopped"] as const) {
    const f = fixture();
    try {
      f.store.mutate(f.id, "fixture.status", false, (g) => {
        g.project.status = status;
      });
      f.action("retest");
      assert.equal(f.store.get(f.id).project.status, status === "completed" ? "active" : "stopped");
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.store.revokeAssets(f.id, ["a001"]);
    const before = f.store.get(f.id);
    assert.throws(() => f.action("retest"), /revok|撤|批准/);
    assert.deepEqual(f.store.get(f.id), before);
  } finally {
    f.store.close();
  }
});

test("项目不接受旧类型参数，所有完成判断都由 Decide 使用 goal", () => {
  // `mode` 现在是架构模式（classic/swarm）的受控枚举；旧的 objective/assessment 概念仍被拒绝。
  for (const mode of ["objective", "assessment"])
    assert.throws(
      () => createProjectSchema.parse({ title: "test", origin: "https://example.test", goal: "Assess", mode }),
      /Unrecognized|Invalid option/,
    );
  const f = fixture();
  try {
    assert.equal("mode" in f.store.get(f.id).project, false);
  } finally {
    f.store.close();
  }
});
