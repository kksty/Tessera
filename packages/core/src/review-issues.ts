import type {
  Graph,
  ProjectMode,
  Review,
  ReviewIssueDisposition,
  ReviewIssueWaiver,
} from "../../protocol/src/models.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { reviewIssueRisk, reviewIssueWaiver, type ReviewIssueRisk } from "../../protocol/src/review-issues.js";

export interface ReviewIssue {
  review: Review;
  index: number;
  issue: string;
  risk: ReviewIssueRisk;
  waiver?: ReviewIssueWaiver;
}

const issueKey = (reviewId: string, index: number) => `${reviewId}:${index}`;

function preview(issue: string) {
  return issue.length > 180 ? `${issue.slice(0, 180)}…` : issue;
}

/**
 * Current planning issues: the latest Review for each active Finding version.
 * A newer review supersedes the old one; a finding removed by deletion, merge or
 * withdrawal no longer holds the gate. A content revision does not erase the
 * issue: the new version is pending a fresh Review.
 */
export function latestReviewIssues(graph: Graph, retired: Set<string> = new Set()): ReviewIssue[] {
  const g = activeGraph(graph);
  const issues: ReviewIssue[] = [];
  for (const finding of g.findings) {
    if (finding.merged_into || finding.withdrawn_at || retired.has(finding.id)) continue;
    const review = g.reviews
      .filter((candidate) => candidate.finding_id === finding.id && candidate.finding_version === finding.version)
      .at(-1);
    if (!review?.planning_issues?.length) continue;
    review.planning_issues.forEach((issue, index) => {
      issues.push({ review, index, issue, risk: reviewIssueRisk(issue), waiver: reviewIssueWaiver(review, index) });
    });
  }
  return issues;
}

/** Issues that still need Decide action or an operator waiver. */
export function openReviewIssues(graph: Graph, retired: Set<string> = new Set()): ReviewIssue[] {
  return latestReviewIssues(graph, retired).filter((issue) => !issue.waiver);
}

export interface ReviewIssueGateOptions {
  retired?: Set<string>;
  /** Steps this settlement closes but has not applied yet. */
  closingIds?: Set<string>;
  /** Steps this settlement reopens; they no longer answer anything. */
  reopenedIds?: Set<string>;
  /** swarm 没有 Step：addressed 必须由 Review 之后保存的原始证据证明。 */
  mode?: ProjectMode;
}

/**
 * The completion gate for Review planning issues. A passing Review may raise an
 * explicit new question ("suspected IDOR", "unauthorized data", "PII"); completion
 * must name work that answered it, or record a reasoned dismissal. There is no
 * human-only class: `reviewIssueRisk` is an advisory label for reviewers and the
 * UI, not an approval gate. An operator waiver stays available as an optional
 * shortcut and simply removes the question from the open list.
 */
export function reviewIssueConflicts(
  graph: Graph,
  dispositions: ReviewIssueDisposition[] = [],
  options: ReviewIssueGateOptions = {},
): string[] {
  const g = activeGraph(graph);
  const open = openReviewIssues(g, options.retired);
  if (!open.length) return [];
  const byKey = new Map(
    dispositions.map((disposition) => [issueKey(disposition.review_id, disposition.issue_index), disposition]),
  );
  const closingIds = options.closingIds ?? new Set<string>();
  const reopenedIds = options.reopenedIds ?? new Set<string>();
  const conflicts: string[] = [];
  for (const item of open) {
    const label = `Review ${item.review.id} 的审核问题 #${item.index}：${preview(item.issue)}`;
    const disposition = byKey.get(issueKey(item.review.id, item.index));
    if (!disposition) {
      conflicts.push(
        `${label} 尚未处置；complete.review_issues 逐条写明 addressed（指向审核后执行并关闭的 Step，swarm 用审核后的新证据）或 waived（说明不追究的理由）`,
      );
      continue;
    }
    const missingEvidence = (disposition.evidence_ids ?? []).filter((id) => !g.evidence.some((e) => e.id === id));
    if (missingEvidence.length) {
      conflicts.push(`${label} 引用了未知证据 ${missingEvidence.join(", ")}`);
      continue;
    }
    if (disposition.status === "addressed") {
      // swarm：没有 Step 可以“执行并关闭”。跟进只能由审核之后保存的原始证据
      // 证明；口头声明或旧证据都不算，避免用一条 message 抹掉问题。
      if (options.mode === "swarm") {
        const fresh = (disposition.evidence_ids ?? []).filter((id) => {
          const evidence = g.evidence.find((item) => item.id === id);
          return !!evidence && evidence.created_at >= item.review.created_at;
        });
        if (!fresh.length) {
          conflicts.push(
            `${label} 标记为 addressed，但没有引用审核之后保存的新原始证据；swarm 请把跟进产生的 Evidence 列入 evidence_ids`,
          );
        }
        continue;
      }
      const step = g.steps.find((candidate) => candidate.id === disposition.step_id);
      const answeredAfterReview = !!step?.executed_at && step.executed_at >= item.review.created_at;
      const concluded =
        !!step && !step.discarded && !reopenedIds.has(step.id) && (!!step.concluded_at || closingIds.has(step.id));
      if (!step || !answeredAfterReview || !concluded) {
        conflicts.push(
          `${label} 标记为 addressed，但 ${disposition.step_id ?? "未指定 Step"} 不是在审核之后执行并关闭的有效 Step；请先建 Step、执行并关闭，再用同一 Step 完成`,
        );
      }
      continue;
    }
    if (!disposition.reason?.trim()) conflicts.push(`${label} 标记为 waived，但缺少不追究的理由`);
  }
  return conflicts;
}
