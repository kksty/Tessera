import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/core/src/store.js";
import {
  createProjectSchema,
  executeSchema,
  findingSchema,
  planningRevision,
  reviewSchema,
  reviewIssueRisk,
  reviewIssueWaiverSchema,
  submitDecisionsSchema,
  type Job,
  type Review,
} from "../../packages/protocol/src/index.js";
import { cvss } from "../fixtures/cvss.js";
import { reportFields } from "../fixtures/report.js";
import { deferDecideMs } from "../helpers/scheduling.js";

function fixture(issue: string) {
  const store = new Store(":memory:");
  const graph = store.create(
    createProjectSchema.parse({ title: "Review issues", origin: "https://example.test", goal: "Assess" }),
  );
  const id = graph.project.id;
  const evidence = store.addEvidence(id, {
    title: "Original",
    content: "response",
    encoding: "utf8",
    mime_type: "text/plain",
  });
  const finding = store.submitFinding(
    id,
    findingSchema.parse({
      ...reportFields,
      title: "Claim",
      description: "Supported claim",
      evidence_ids: [evidence.id],
    }),
  );
  const reviewer = store.claim(id, "reviewer", deferDecideMs)!;
  const review = store.review(
    id,
    finding.id,
    reviewSchema.parse({
      worker: reviewer.worker,
      finding_version: 1,
      verdict: "pass",
      kind: "vulnerability",
      reason: "Original proof inspected",
      evidence_ids: [evidence.id],
      cvss: cvss.high,
      planning_issues: [issue],
    }),
  ) as Review;
  const planner = store.claim(id, "planner", 0)!;
  return { store, id, evidence, finding, review, planner };
}

function settle(store: Store, id: string, job: Job, body: Record<string, unknown>) {
  const graph = store.get(id);
  return store.submitDecisions(
    id,
    submitDecisionsSchema.parse({
      submission_id: randomUUID(),
      worker: job.worker,
      revision: graph.revision,
      observation_revision: graph.observation_revision,
      planning_revision: planningRevision(graph),
      ...body,
    }),
    job.run_id,
  );
}

function completeBody(extra: Record<string, unknown> = {}) {
  return { complete: { from: ["origin"], description: "Stop with documented limitations", ...extra } };
}

test("authorization and personal-data questions are classified as high risk", () => {
  for (const issue of [
    "疑似 IDOR：按 metadataId 读取他人信件",
    "未授权访问其他租户的订单",
    "越权读取其他用户的记录",
    "接口返回 PII，需确认是否可批量枚举",
    "身份证号和手机号出现在响应中",
    "跨用户读取同一资源",
    "cross-tenant object reference",
  ])
    assert.equal(reviewIssueRisk(issue), "high", issue);
  for (const issue of [
    "确认 CORS 响应头是否扩大了实际影响",
    "确认真实 siteId 是否值得继续枚举公开统计",
    "复核错误页是否泄露组件版本",
  ])
    assert.equal(reviewIssueRisk(issue), "normal", issue);
});

test("a Review planning issue blocks completion until Decide disposes of it", () => {
  const f = fixture("疑似 IDOR：viewGovmsgbox 可按 metadataId 读取他人信件");
  try {
    const blocked = settle(f.store, f.id, f.planner, completeBody());
    assert.equal(blocked.settle.ok, false);
    assert.match(blocked.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /Review r001 的审核问题 #0/);
    assert.match(blocked.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /尚未处置/);
    const graph = f.store.get(f.id);
    assert.equal(graph.project.status, "active");
    assert.equal(graph.project.pending_completion, undefined);
  } finally {
    f.store.close();
  }
});

test("a low-risk Review issue can be waived with a reason, but not silently", () => {
  const f = fixture("确认 CORS 响应头是否扩大了实际影响");
  try {
    const silent = settle(f.store, f.id, f.planner, completeBody());
    assert.equal(silent.settle.ok, false);
    assert.match(silent.settle.conflicts[0].reason, /尚未处置/);

    const waived = settle(
      f.store,
      f.id,
      f.planner,
      completeBody({
        review_issues: [
          {
            review_id: f.review.id,
            issue_index: 0,
            status: "waived",
            reason: "已验证 CORS 只影响公开统计，没有额外的凭据读取路径",
          },
        ],
      }),
    );
    assert.equal(waived.settle.ok, true, waived.settle.conflicts.map((conflict) => conflict.reason).join("; "));
    assert.equal(f.store.get(f.id).project.status, "completed");
    assert.deepEqual(f.store.get(f.id).project.pending_completion, undefined);
  } finally {
    f.store.close();
  }
});

test("a high-risk Review issue cannot be waived by the model; an operator waiver closes it", () => {
  const f = fixture("疑似未授权访问：对象引用可以读取其他用户的信息");
  try {
    const modelWaiver = settle(
      f.store,
      f.id,
      f.planner,
      completeBody({
        review_issues: [{ review_id: f.review.id, issue_index: 0, status: "waived", reason: "该接口只返回公开页面" }],
      }),
    );
    assert.equal(modelWaiver.settle.ok, false);
    assert.match(modelWaiver.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /高风险/);
    assert.match(modelWaiver.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /人工豁免/);

    assert.throws(() => f.store.waiveReviewIssue(f.id, f.review.id, 0, { reason: "   " }), /豁免理由不能为空/);
    assert.throws(() => f.store.waiveReviewIssue(f.id, "r999", 0, { reason: "x" }), /Review not found/);
    assert.throws(() => f.store.waiveReviewIssue(f.id, f.review.id, 9, { reason: "x" }), /issue not found/);
    const waived = f.store.waiveReviewIssue(f.id, f.review.id, 0, {
      reason: "已人工核对网关访问控制，该入口只返回当前会话的数据",
      by: "human",
    });
    assert.equal(waived.issue_waivers?.length, 1);
    assert.equal(reviewIssueWaiverSchema.parse({ reason: "manual decision" }).by, "human");

    const completed = settle(f.store, f.id, f.planner, completeBody());
    assert.equal(completed.settle.ok, true, completed.settle.conflicts.map((conflict) => conflict.reason).join("; "));
    assert.equal(f.store.get(f.id).project.status, "completed");
  } finally {
    f.store.close();
  }
});

test("a Review issue is addressed only by a Step executed and concluded after the Review", () => {
  const f = fixture("疑似 IDOR：不同 metadataId 的归属校验需要复测");
  try {
    const planned = settle(f.store, f.id, f.planner, {
      steps: [
        {
          from: ["origin"],
          description: "Retest the mailbox object reference",
          property: "伪造 metadataId 不能读取他人信件",
        },
      ],
    });
    assert.equal(planned.settle.ok, true);
    const step = f.store.get(f.id).steps.at(-1)!;
    const executor = f.store.claim(f.id, "executor", 0)!;
    assert.equal(executor.kind, "execute");
    f.store.execute(
      f.id,
      step.id,
      executeSchema.parse({ worker: executor.worker, summary: "Object ownership was enforced" }),
    );
    const graph = f.store.get(f.id);
    const executed = graph.steps.find((candidate) => candidate.id === step.id)!;
    assert.ok(executed.executed_at);
    const planner = f.store.claim(f.id, "planner-2", 0)!;

    const addressed = settle(f.store, f.id, planner, {
      closes: [
        {
          id: step.id,
          reason: "Ownership check answered",
          evidence_ids: [f.evidence.id],
          expected_version: executed.version,
        },
      ],
      complete: {
        from: ["origin"],
        description: "Follow-up work answered the review question",
        review_issues: [{ review_id: f.review.id, issue_index: 0, status: "addressed", step_id: step.id }],
      },
    });
    assert.equal(addressed.settle.ok, true, addressed.settle.conflicts.map((conflict) => conflict.reason).join("; "));
    assert.equal(f.store.get(f.id).project.status, "completed");
  } finally {
    f.store.close();
  }
});

test("addressed cannot point at a step that never ran or is not the review's follow-up work", () => {
  const f = fixture("复核该入口是否允许跨用户读取");
  try {
    const planned = settle(f.store, f.id, f.planner, {
      steps: [{ from: ["origin"], description: "Unrelated branch" }],
    });
    assert.equal(planned.settle.ok, true);
    const step = f.store.get(f.id).steps.at(-1)!;
    f.store.closeStep(f.id, step.id, {
      worker: "human",
      reason: "Closed without a run",
      evidence_ids: [f.evidence.id],
      expected_version: step.version,
    });
    const planner = f.store.claim(f.id, "planner-2", 0)!;
    assert.equal(planner.kind, "decide");
    const invalid = settle(f.store, f.id, planner, {
      complete: {
        from: ["origin"],
        description: "Claim the issue was answered",
        review_issues: [{ review_id: f.review.id, issue_index: 0, status: "addressed", step_id: step.id }],
      },
    });
    assert.equal(invalid.settle.ok, false);
    assert.match(
      invalid.settle.conflicts.map((conflict) => conflict.reason).join("\n"),
      /不是在审核之后执行并关闭的有效 Step/,
    );
  } finally {
    f.store.close();
  }
});

test("reopening an operator waiver puts the issue back in front of completion", () => {
  const f = fixture("疑似越权读取其他用户的记录");
  try {
    f.store.waiveReviewIssue(f.id, f.review.id, 0, { reason: "Temporary acknowledgement" });
    const before = planningRevision(f.store.get(f.id));
    assert.equal(f.store.reopenReviewIssue(f.id, f.review.id, 0).issue_waivers, undefined);
    assert.ok(
      planningRevision(f.store.get(f.id)) > before,
      "reopening a waiver invalidates stale completion and wakes Decide",
    );
    const blocked = settle(f.store, f.id, f.planner, completeBody());
    assert.equal(blocked.settle.ok, false);
    assert.match(blocked.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /高风险/);
  } finally {
    f.store.close();
  }
});

test("a same-batch finding revision cannot erase the current version's Review issue", () => {
  const f = fixture("疑似 IDOR：metadataId 归属校验缺失");
  try {
    const revised = settle(f.store, f.id, f.planner, {
      finding_updates: [
        {
          id: f.finding.id,
          expected_version: f.finding.version,
          reason: "Clarify the claim wording",
          changes: { title: "Clarified claim" },
        },
      ],
      complete: { from: ["origin"], description: "Revise and finish in one batch" },
    });
    assert.equal(revised.settle.ok, false);
    assert.match(revised.settle.conflicts.map((conflict) => conflict.reason).join("\n"), /尚未处置/);
    assert.equal(f.store.get(f.id).findings[0].version, f.finding.version, "the settlement is atomic");
  } finally {
    f.store.close();
  }
});
