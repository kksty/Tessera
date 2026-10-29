import type { ReviewGate } from "./review-scheduling.js";
import { Finding, Review } from "./models-finding.js";
import { Project } from "./models-project.js";

/** 跨项目汇总使用的风险分档：severity 缺失或为 null 时统一落入 ungraded。 */
export type SeverityBucket = "critical" | "high" | "medium" | "low" | "informational" | "ungraded";

export type SeverityCounts = Record<SeverityBucket, number>;

/** 扁平化的发现条目：跨项目列表与总览共用，不携带正文。 */
export interface OverviewFinding {
  kind: Finding["kind"];
  classification_review_required: boolean;
  id: string;
  project_id: string;
  project_title: string;
  title: string;
  severity: SeverityBucket;
  status: Finding["status"];
  review_status: Finding["review_status"];
  /** 当前版本已审核通过、带证据，且属于漏洞类（非 informational）。 */
  confirmed: boolean;
  /** Review 判定的非漏洞类（informational）：保留记录，但不进入风险统计与报告正文。 */
  informational: boolean;
  /** 当前版本已经审核过（无论结论）。 */
  reviewed: boolean;
  /** 操作员已人工批准当前版本；批准的发现不再进入待审核/待处理列表。 */
  approved: boolean;
  /** 审核调度状态；旧服务端可能不返回此字段。 */
  review_gate?: ReviewGate;
  created_at: string;
  /** 只有当前版本审核通过的非信息类发现才带权威评分。 */
  cvss_score: number | null;
  asset_hostname: string | null;
  graph_id: string;
  step_id: string | null;
}

export interface OverviewProject {
  id: string;
  title: string;
  status: Project["status"];
  created_at: string;
  last_activity_at: string;
  finding_count: number;
  confirmed: number;
  /** 当前版本已确认的非漏洞类发现，不计入风险。 */
  informational: number;
  pending_review: number;
  /** 仅统计当前版本已确认的发现。 */
  severity: SeverityCounts;
  open_steps: number;
  running_steps: number;
  assets: number;
  approved_assets: number;
  pending_assets: number;
  evidence: number;
  traffic: number;
  last_error?: string;
}

export interface OverviewTrendPoint {
  day: string;
  created: number;
  reviewed: number;
}

/** 近 14 天按 UTC 日期汇总的模型用量；缺失字段不计入 token，但请求仍然计数。 */
export interface OverviewUsagePoint {
  day: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  requests: number;
  /** 输入或输出未上报的请求数；缺失字段不计入合计，已上报字段仍然保留。 */
  unknown: number;
}

export interface OverviewUsage {
  /** 与 trend 同一 14 天窗口的合计，不包含更早的请求。 */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  requests: number;
  unknown: number;
  trend: OverviewUsagePoint[];
}

export interface OverviewAttention {
  project_id: string;
  project_title: string;
  kind: "review" | "assets" | "error";
  count: number;
  detail: string;
}

export interface SecurityOverview {
  generated_at: string;
  totals: {
    projects: number;
    active_projects: number;
    findings: number;
    /** 已确认漏洞：审核通过且属于漏洞类。 */
    confirmed: number;
    /** 已确认的信息类发现：不计入风险。 */
    informational: number;
    pending_review: number;
    severity: SeverityCounts;
    assets: number;
    approved_assets: number;
    pending_assets: number;
    evidence: number;
    reviews: number;
    traffic: number;
  };
  projects: OverviewProject[];
  recent: OverviewFinding[];
  priority: OverviewFinding[];
  attention: OverviewAttention[];
  trend: OverviewTrendPoint[];
  usage: OverviewUsage;
}

export interface ProjectSummary extends Project {
  search_state?: "exploring" | "reviewing" | "completed" | "paused";
  fact_count: number;
  intent_count: number;
  working_intent_count: number;
  unclaimed_intent_count: number;
  hint_count: number;
  /** 当前仍在图上的发现总数（不含已合并、已撤回），包括候选与未通过审核的记录。 */
  finding_count: number;
  /** 当前版本审核通过、属于漏洞类且带有效评分的已确认漏洞。 */
  confirmed_finding_count: number;
  /** 当前版本已确认的信息类发现；不计入漏洞总数。 */
  informational_finding_count: number;
  pending_asset_count: number;
  review_pending_count: number;
}
