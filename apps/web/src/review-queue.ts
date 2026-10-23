import type { OverviewFinding } from "../../../packages/protocol/src/index.js";
import type { ReviewGate } from "../../../packages/protocol/src/review-scheduling.js";

export const reviewGateLabels: Record<ReviewGate, string> = {
  reviewing: "正在审核",
  ready: "等待领取",
  source_unfinished: "等待执行结束",
  asset_unapproved: "等待资产批准",
  backoff: "等待重试",
  review_limit: "等待审核空位",
  inactive: "项目已暂停或完成",
  current: "已审核",
  excluded: "已排除",
};

export function reviewQueue(findings: readonly OverviewFinding[]) {
  return findings.filter(finding => !finding.reviewed && finding.review_gate !== "excluded");
}

export function reviewSummary(findings: readonly OverviewFinding[]) {
  const queue = reviewQueue(findings);
  const reviewing = queue.filter(finding => finding.review_gate === "reviewing").length;
  return { total: queue.length, reviewing, waiting: queue.length - reviewing };
}
