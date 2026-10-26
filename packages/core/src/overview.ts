import type {
  Finding,
  Graph,
  OverviewAttention,
  OverviewFinding,
  OverviewProject,
  OverviewTrendPoint,
  OverviewUsage,
  OverviewUsagePoint,
  SecurityOverview,
  SeverityBucket,
  SeverityCounts,
} from "../../protocol/src/index.js";
import type { Store } from "./store.js";
import { activeGraph } from "../../protocol/src/node-lifecycle.js";
import { pendingReviews, reviewGate } from "../../protocol/src/review-scheduling.js";
import {
  confirmedFinding,
  confirmedVulnerability,
  confirmedInformational,
  informationalFinding,
  currentCvssScore,
  findingKind,
  classificationReviewRequired,
  humanApproved,
} from "../../protocol/src/finding-policy.js";
export {
  confirmedFinding,
  confirmedVulnerability,
  confirmedInformational,
  informationalFinding,
  currentCvssScore,
} from "../../protocol/src/finding-policy.js";

/**
 * 跨项目总览：把每个项目的图读一次，在 JS 里汇总。
 * 只读取计数与索引字段，不调用 projection，也不逐项目 store.get() 重复解析。
 */

const buckets: SeverityBucket[] = ["critical", "high", "medium", "low", "informational", "ungraded"];

const emptySeverity = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  informational: 0,
  ungraded: 0,
});

const severityRank: Record<SeverityBucket, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  informational: 1,
  ungraded: 0,
};

const bucketOf = (finding: Finding): SeverityBucket => (finding.severity || "ungraded") as SeverityBucket;

export const reviewedFinding = (finding: Finding) =>
  finding.reviewed_version === finding.version && finding.review_status !== "pending";

const trendDays = 14;

const dayOf = (iso: string | undefined | null) =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;

const emptyTrend = (now = new Date()): OverviewTrendPoint[] => {
  const points: OverviewTrendPoint[] = [];
  for (let offset = trendDays - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    points.push({ day: date.toISOString().slice(0, 10), created: 0, reviewed: 0 });
  }
  return points;
};

const emptyUsageTrend = (days: OverviewTrendPoint[]): OverviewUsagePoint[] =>
  days.map((point) => ({
    day: point.day,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    requests: 0,
    unknown: 0,
  }));

const usageOf = (trend: OverviewUsagePoint[]): OverviewUsage => {
  const total = trend.reduce(
    (sum, point) => ({
      input: sum.input + point.input,
      output: sum.output + point.output,
      cache_read: sum.cache_read + point.cache_read,
      cache_write: sum.cache_write + point.cache_write,
      requests: sum.requests + point.requests,
      unknown: sum.unknown + point.unknown,
    }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0, unknown: 0 },
  );
  return { ...total, trend };
};

const compactFinding = (
  finding: Finding,
  project: { id: string; title: string },
  assets: Map<string, string>,
  graph: Graph,
): OverviewFinding => ({
  kind: findingKind(finding),
  classification_review_required: classificationReviewRequired(finding, graph),
  id: finding.id,
  project_id: project.id,
  project_title: project.title,
  title: finding.title,
  severity: bucketOf(finding),
  status: finding.status,
  review_status: finding.review_status,
  confirmed: confirmedVulnerability(finding, graph),
  informational: informationalFinding(finding),
  reviewed: reviewedFinding(finding) && !classificationReviewRequired(finding, graph),
  approved: humanApproved(finding),
  review_gate: reviewGate(graph, finding),
  created_at: finding.created_at,
  cvss_score: currentCvssScore(finding, graph),
  asset_hostname: (finding.asset_id && assets.get(finding.asset_id)) || null,
  graph_id: finding.graph_id,
  step_id: finding.step_id ?? null,
});

const descending = (left: string, right: string) => (left < right ? 1 : left > right ? -1 : 0);

export function securityOverview(store: Store): SecurityOverview {
  const rows = store.db.prepare("SELECT id,data FROM platform_projects ORDER BY rowid DESC").all() as {
    id: string;
    data: string;
  }[];
  const activity = new Map(
    (
      store.db
        .prepare("SELECT project_id AS id, MAX(created_at) AS last FROM platform_event_history GROUP BY project_id")
        .all() as { id: string; last: string }[]
    ).map((row) => [row.id, row.last]),
  );
  const traffic = new Map(
    (
      store.db.prepare("SELECT project_id AS id, count AS total FROM project_traffic_totals").all() as {
        id: string;
        total: number;
      }[]
    ).map((row) => [row.id, Number(row.total)]),
  );

  const projects: OverviewProject[] = [];
  const recent: OverviewFinding[] = [];
  const priority: OverviewFinding[] = [];
  const attention: OverviewAttention[] = [];
  const totals = {
    projects: 0,
    active_projects: 0,
    findings: 0,
    confirmed: 0,
    informational: 0,
    pending_review: 0,
    severity: emptySeverity(),
    assets: 0,
    approved_assets: 0,
    pending_assets: 0,
    evidence: 0,
    reviews: 0,
    traffic: 0,
  };
  const trend = emptyTrend();
  const trendIndex = new Map(trend.map((point) => [point.day, point]));
  const usageTrend = emptyUsageTrend(trend);
  const usageIndex = new Map(usageTrend.map((point) => [point.day, point]));

  for (const row of rows) {
    if (JSON.parse(row.data).format_version !== 1) continue;
    const graph = activeGraph(store.get(row.id));
    if (graph.format_version !== 1) continue;
    const project = graph.project;
    const findings = (graph.findings ?? []).filter((f) => !f.merged_into && !f.withdrawn_at);
    const assets = graph.assets ?? [];
    const assetNames = new Map(assets.map((asset) => [asset.id, asset.hostname]));

    const severity = emptySeverity();
    let confirmed = 0;
    let informational = 0;
    const pendingReview = pendingReviews(graph).length;
    let runningSteps = 0;
    let openSteps = 0;
    const approvedAssets = assets.filter((asset) => asset.approval === "approved").length;
    const pendingAssets = assets.filter((asset) => asset.approval === "pending").length;

    for (const finding of findings) {
      if (confirmedFinding(finding, graph)) {
        if (informationalFinding(finding)) informational++;
        else {
          confirmed++;
          severity[bucketOf(finding)]++;
        }
      }
    }
    for (const step of graph.steps ?? []) {
      if (step.discarded || step.concluded_at) continue;
      openSteps++;
      if (step.worker) runningSteps++;
    }
    for (const review of graph.reviews ?? []) {
      const point = trendIndex.get(dayOf(review.created_at) || "");
      if (point) point.reviewed++;
      totals.reviews++;
    }
    // 只汇总窗口内的请求；更早的用量属于项目累计，不进入这张 14 天图。
    for (const record of graph.usage ?? []) {
      const point = usageIndex.get(dayOf(record.created_at) || "");
      if (!point) continue;
      point.requests++;
      if (record.input == null || record.output == null) point.unknown++;
      if (record.input != null) point.input += record.input;
      if (record.output != null) point.output += record.output;
      if (record.cache_read != null) point.cache_read += record.cache_read;
      if (record.cache_write != null) point.cache_write += record.cache_write;
    }
    for (const finding of findings) {
      const point = trendIndex.get(dayOf(finding.created_at) || "");
      if (point && confirmedVulnerability(finding, graph)) point.created++;
      const compact = compactFinding(finding, project, assetNames, graph);
      recent.push(compact);
      if (compact.confirmed && (compact.severity === "critical" || compact.severity === "high")) priority.push(compact);
    }

    totals.projects++;
    if (project.status === "active") totals.active_projects++;
    totals.findings += findings.length;
    totals.confirmed += confirmed;
    totals.informational += informational;
    totals.pending_review += pendingReview;
    for (const key of buckets) totals.severity[key] += severity[key];
    totals.assets += assets.length;
    totals.approved_assets += approvedAssets;
    totals.pending_assets += pendingAssets;
    totals.evidence += (graph.evidence ?? []).length;
    totals.traffic += traffic.get(project.id) ?? 0;

    projects.push({
      id: project.id,
      title: project.title,
      status: project.status,
      created_at: project.created_at,
      last_activity_at: activity.get(project.id) || project.created_at,
      finding_count: findings.length,
      confirmed,
      informational,
      pending_review: pendingReview,
      severity,
      open_steps: openSteps,
      running_steps: runningSteps,
      assets: assets.length,
      approved_assets: approvedAssets,
      pending_assets: pendingAssets,
      evidence: (graph.evidence ?? []).length,
      traffic: traffic.get(project.id) ?? 0,
      ...(project.last_error ? { last_error: project.last_error } : {}),
    });

    if (pendingReview)
      attention.push({
        project_id: project.id,
        project_title: project.title,
        kind: "review",
        count: pendingReview,
        detail: "候选发现等待独立审核，尚未计入风险统计。",
      });
    if (pendingAssets)
      attention.push({
        project_id: project.id,
        project_title: project.title,
        kind: "assets",
        count: pendingAssets,
        detail: "新发现的子域名需要人工批准后才会进入测试范围。",
      });
    if (project.last_error)
      attention.push({
        project_id: project.id,
        project_title: project.title,
        kind: "error",
        count: 1,
        detail: project.last_error,
      });
  }

  const byRisk = (left: OverviewFinding, right: OverviewFinding) =>
    severityRank[right.severity] - severityRank[left.severity] || descending(left.created_at, right.created_at);
  recent.sort((left, right) => descending(left.created_at, right.created_at));
  priority.sort(byRisk);

  projects.sort(
    (left, right) =>
      descending(left.last_activity_at, right.last_activity_at) || left.title.localeCompare(right.title, "zh-CN"),
  );

  return {
    generated_at: new Date().toISOString(),
    totals,
    projects,
    recent: recent.slice(0, 8),
    priority: priority.slice(0, 8),
    attention: attention.sort((left, right) => right.count - left.count).slice(0, 8),
    trend,
    usage: usageOf(usageTrend),
  };
}

export function allOverviewFindings(store: Store): OverviewFinding[] {
  const rows = store.db.prepare("SELECT id,data FROM platform_projects ORDER BY rowid DESC").all() as {
    id: string;
    data: string;
  }[];
  const findings: OverviewFinding[] = [];
  for (const row of rows) {
    if (JSON.parse(row.data).format_version !== 1) continue;
    const graph = activeGraph(store.get(row.id));
    if (graph.format_version !== 1) continue;
    const assets = new Map((graph.assets ?? []).map((asset) => [asset.id, asset.hostname]));
    for (const finding of graph.findings ?? [])
      if (!finding.merged_into && !finding.withdrawn_at)
        findings.push(compactFinding(finding, graph.project, assets, graph));
  }
  return findings.sort(
    (left, right) =>
      severityRank[right.severity] - severityRank[left.severity] || descending(left.created_at, right.created_at),
  );
}
