import type { z } from "zod";
import type {
  factStatusSchema,
  findingIdentitySchema,
  reproductionSchema,
  cvssSchema,
  coverageEntrySchema,
} from "./schemas.js";
import type { TestDomain } from "./domains.js";
import type { ReviewGate } from "./review-scheduling.js";

export type FactStatus = z.infer<typeof factStatusSchema>;
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export interface NodeDeletion {
  at: string;
  by: string;
  run_id?: string;
  submission_id: string;
  reason: string;
  root_id: string;
  cascade: "none" | "downstream";
}
export interface DeletedNodeRef {
  id: string;
  kind: "facts" | "steps" | "findings" | "goals";
  deleted_at: string;
  history_ref: string;
}

export interface Bookmark {
  id: string;
  node_id: string;
  reason: string;
  revisit_when: string;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
  run_id: string;
  withdrawn_at?: string;
}

export interface Fact {
  deleted?: NodeDeletion;
  id: string;
  description: string;
  /** What this fact asserts; complete (≤120), never truncated by a projection. */
  conclusion?: string;
  /** Set only by migration backfill; the projection marks inferred conclusions. */
  conclusion_inferred?: boolean;
  status?: FactStatus;
  /** Affected assets, ports or paths; optional. */
  objects?: string[];
  /** The exact request that produced a negative result, when one was made. */
  request?: { method: string; url: string };
  /** Where each parameter value came from; required before a negative claim can pass Review. */
  parameter_sources?: { parameter: string; source: string; evidence_ids?: string[] }[];
  /**
   * Marks facts created under the strict negative-claim contract. Legacy facts
   * lack it and stay reviewable; new not_observed facts always carry it, so a
   * missing request/provenance is rejected instead of silently accepted.
   */
  negative_claim_version?: 1;
  graph_id: string;
  evidence_ids: string[];
  /** Server-recorded production identity. Legacy/manual records may omit these fields. */
  step_id?: string;
  run_id?: string;
  created_at?: string;
  asset_id?: string;
  kind?: "observation" | "navigation";
  last_referenced_round?: number;
  last_read_round?: number;
  cooldown_override?: CooldownOverride;
  /** Human rewrites keep the replaced text; only the origin fact is editable. */
  edits?: TextEdit[];
}
export interface Goal {
  deleted?: NodeDeletion;
  id: string;
  description: string;
  state: "active" | "satisfied" | "withdrawn";
  graph_id: string;
  /** Human rewrites keep the replaced text; see TextEdit. */
  edits?: TextEdit[];
}
export type CooldownOverride = "auto" | "pinned" | "cooled";
export interface Step {
  /** A human-requested retest must submit results to this existing Finding. */
  retest_finding_id?: string;
  deleted?: NodeDeletion;
  /** Read-view metadata only; originals remain in historical Step.fact_ids/summary. */
  deleted_output_ids?: string[];
  id: string;
  from: string[];
  to: string | null;
  description: string;
  /** A falsifiable property the executor must answer; the description is the activity. */
  property?: string;
  /** Optional suggested technique; the executor remains free to choose its method. */
  method_hint?: string;
  /** 测试域；只影响分组、筛选与统计，不作为完成、审核或授权门槛。 */
  test_domain?: TestDomain;
  /** 域内细节，≤20 字；后渗透使用「提权：SUID」这类固定前缀。 */
  focus?: string;
  priority: number;
  /** Incremented by execute, close, reopen, discard and priority changes; settle checks it. */
  version?: number;
  discarded: boolean;
  discard_reason?: string;
  creator: string;
  worker: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  executed_at?: string | null;
  concluded_at: string | null;
  close_reason?: string;
  /** The decider's reason for undoing the last close; the event stream keeps every earlier reopen. */
  reopen_reason?: string;
  fact_ids: string[];
  summary: string;
  graph_id: string;
  asset_id?: string;
  goal_id?: string;
  hint_ids?: string[];
  /** Leads this Step is meant to resolve, set when the Step is planned. */
  lead_ids?: string[];
  /**
   * Present on the synthetic completion Step only. The accepted completion
   * accounting is copied here before `pending_completion` is cleared, so the
   * coverage table remains readable after the project completes instead of
   * surviving only in raw submissions.
   */
  completion?: CompletionRecord;
  /** Hint wording versions carried by this Step; absent legacy entries mean version 1. */
  hint_versions?: Record<string, number>;
  attempts: number;
  retry_at?: string;
  blocked_run_id?: string;
  run_id?: string;
  last_referenced_round?: number;
  last_read_round?: number;
  cooldown_override?: CooldownOverride;
  /** Rewrites keep the replaced text; `editor` records whether a human or a Decide merge wrote it. */
  edits?: TextEdit[];
}
/** A rewrite of a model-owned text field. `editor` identifies the author ("human" for an operator rewrite, the worker id for a Decide merge); the replaced text is kept, never discarded. */
export interface TextEdit {
  at: string;
  editor: string;
  field: "description" | "property" | "method_hint";
  from: string;
}
export type FindingIdentity = z.infer<typeof findingIdentitySchema>;
export type Reproduction = z.infer<typeof reproductionSchema>;
export interface Finding {
  /** Latest operator direction; earlier directions remain in Reviews/events. */
  human_feedback?: {
    action: "return" | "retest";
    reason: string;
    by: string;
    at: string;
    version: number;
    step_id?: string;
    /** Evidence cited by the version the retest must improve on. */
    baseline_evidence_ids?: string[];
  };
  /** Undefined only on legacy rows; null explicitly means unclassified. */
  kind?: "vulnerability" | "informational" | null;
  deleted?: NodeDeletion;
  /** Latest operator undo of a deletion; the original tombstone stays auditable here. */
  restored?: { at: string; by: string; deletion: NodeDeletion };
  /** Merged sources stay readable for audit; only the target remains actionable. */
  merged_into?: string;
  merge_reason?: string;
  merged_at?: string;
  merged_by?: string;
  withdrawn_at?: string;
  withdrawn_by?: string;
  withdrawal_reason?: string;
  edits?: {
    at: string;
    editor: string;
    reason: string;
    version: number;
    previous: Pick<
      Finding,
      | "title"
      | "description"
      | "evidence"
      | "evidence_ids"
      | "traffic_ids"
      | "from"
      | "kind"
      | "severity"
      | "severity_reason"
      | "impact"
      | "reproduction"
      | "remediation"
      | "identity"
      | "cvss"
    >;
  }[];
  severity_before_review?: Finding["severity"];
  severity_reason_before_review?: string | null;
  revision_step_id?: string;
  id: string;
  title: string;
  description: string;
  evidence: string;
  evidence_ids: string[];
  /**
   * HTTP flows captured by the recording proxy for this claim. The executor
   * cites the exact request(s) it sent; operators open them from the Finding.
   */
  traffic_ids?: string[];
  from: string[];
  status: "candidate" | "confirmed" | "rejected";
  version: number;
  reviewed_version: number;
  review_status: "pending" | "pass" | "needs_evidence" | "rejected";
  /**
   * Current version was accepted without a Review run because the operator
   * limited Review to vulnerability claims. Informational only; never a verdict.
   */
  review_exempt?: "informational";
  /**
   * Set when an operator asked for a real Review of an exempt finding. The
   * informational exemption must not silently swallow that request on the next
   * claim, even while the platform switch stays on.
   */
  review_requested?: { at: string; by: string; reason: string };
  /**
   * Operator approval of this exact Finding version. Approved findings leave the
   * pending queues (Review queue, project overview, navigation badges) and are the
   * only ones listed under the Findings page's "已批准" tab. A new version never
   * inherits the approval.
   */
  human_approval?: { at: string; by: string; version: number; reason?: string };
  created_at: string;
  graph_id: string;
  asset_id?: string;
  step_id?: string;
  review_worker?: string | null;
  review_run_id?: string;
  review_heartbeat?: string | null;
  retry_at?: string;
  verification_step_id?: string;
  severity?: "critical" | "high" | "medium" | "low" | "informational" | null;
  severity_reason?: string | null;
  impact?: string | null;
  reproduction?: Reproduction | null;
  remediation?: string | null;
  identity?: FindingIdentity | null;
  /** CVSS v4.0 vector, score computed by the application, and the reviewer's rationale. */
  cvss?: z.infer<typeof cvssSchema> | null;
  last_referenced_round?: number;
  last_read_round?: number;
  cooldown_override?: CooldownOverride;
}
export interface Asset {
  id: string;
  hostname: string;
  source: string;
  evidence_ids: string[];
  approval: "approved" | "pending" | "rejected";
  seed: boolean;
  created_at: string;
  approved_at?: string;
  graph_id?: string;
  /** "cooled" keeps the approval untouched but removes the asset from the planning entry. */
  cooldown_override?: CooldownOverride;
  cool_reason?: string;
  revisit_when?: string;
}
export interface Evidence {
  part_ids?: string[];
  id: string;
  source_path?: string;
  title: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: string;
  step_id?: string;
  asset_id?: string;
  /** false for binary bodies: metadata is searchable, the body is not indexed. */
  indexed?: boolean;
  last_referenced_round?: number;
  last_read_round?: number;
  cooldown_override?: CooldownOverride;
}
/**
 * Operator-only dismissal of one Review planning issue. The model may explain a
 * low-risk issue itself, but a high-risk one (authorization, IDOR, PII) can only
 * be closed by a human decision recorded here.
 */
export interface ReviewIssueWaiver {
  index: number;
  reason: string;
  by: string;
  at: string;
}
export interface Review {
  source?: "model" | "human" | "system";
  /** Explicit new questions for Decide; ordinary pass has none. */
  planning_issues?: string[];
  /** Human waivers for planning_issues by zero-based index. */
  issue_waivers?: ReviewIssueWaiver[];
  kind?: Finding["kind"];
  severity_before_review?: Finding["severity"];
  severity?: Finding["severity"];
  severity_reason?: string | null;
  cvss?: z.infer<typeof cvssSchema> | null;
  id: string;
  finding_id: string;
  finding_version: number;
  verdict: "pass" | "needs_evidence" | "rejected";
  reason: string;
  evidence_ids: string[];
  disputed_fact_ids: string[];
  created_at: string;
  worker: string;
  verification_step_id?: string;
  verification?: string;
}
/**
 * Completion accounting for one Review planning issue. `addressed` names the
 * Step that did the follow-up work; `waived` records why Decide dismissed it.
 * High-risk issues are only waived by an operator, never by this table alone.
 */
export interface ReviewIssueDisposition {
  review_id: string;
  issue_index: number;
  status: "addressed" | "waived";
  step_id?: string;
  reason?: string;
  evidence_ids?: string[];
}
/**
 * Durable copy of the completion proposal accepted by `finalizeCompletion`.
 * `pending_completion` is intentionally cleared, so this record is the graph's
 * only readable coverage table once the project reaches `completed`.
 */
export interface CompletionRecord {
  coverage: CoverageEntry[];
  review_issues?: ReviewIssueDisposition[];
  observation_revision?: number;
  planning_revision?: number;
}
export interface ReasonLease {
  worker: string;
  started_at: string;
  last_heartbeat_at: string;
  run_id?: string;
}
export interface Usage {
  id: string;
  kind: Job["kind"];
  graph_id: string;
  node_id: string | null;
  input: number | null;
  /** input remains total input for legacy compatibility; these are disjoint SDK buckets. */
  input_uncached?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  output: number | null;
  cost: number | null;
  created_at: string;
  run_id?: string;
  request_id?: string;
}
/**
 * A lead is a concrete next question discovered while executing. It is weaker
 * than a Fact (no confirmed result) and stronger than a free-text summary: an
 * open lead blocks completion until Decide converts it into a Step or waives it
 * with a reason.
 */
export interface Lead {
  id: string;
  /** Normalized host/path (or another explicit surface when normalization fails). */
  surface: string;
  parameter?: string;
  why: string;
  suggested_property: string;
  evidence_ids: string[];
  status: "open" | "converted" | "waived";
  /** The Step that produced the lead. */
  step_id?: string;
  run_id?: string;
  created_by?: string;
  created_at: string;
  converted_step_id?: string;
  waiver_reason?: string;
  disposition_at?: string;
  disposition_by?: string;
  last_referenced_round?: number;
  last_read_round?: number;
}
export type LeadStatus = Lead["status"];
export interface Project {
  deletion?: { id: string; requested_at: string; volume_prefix: string; error?: string };
  /** Docker volume prefix used when this project's worker was first created. */
  volume_prefix?: string;
  id: string;
  title: string;
  status: "active" | "stopped" | "completed";
  created_at: string;
  reason: ReasonLease | null;
  decide_retry_at?: string;
  decide_pending_since?: string;
  decide_trigger_at?: string;
  decide_trigger_revision?: number;
  decide_conflicts?: number;
  /** Scheduling cursor only. Absent legacy values start with Execute; never advances observations. */
  last_work_kind?: "execute" | "review";
  last_error?: string;
  /** Incremented once per Decide job that settles; node recency is measured in these rounds. */
  decision_round?: number;
  /** Incremented when the cold-pool membership or the hot-limit rule changes. */
  pool_revision?: number;
  /** Hot budget for entry-listed Facts/Findings. 0 disables cooling (everything stays hot). */
  hot_limit?: number;
  /** Character budget for entry-listed Fact/Finding lines. 0 disables the character budget. */
  hot_char_limit?: number;
  /** Classification of the most recent Run failure, so the UI can name it. */
  last_failure_kind?: Run["failure_kind"];
  /** Consecutive control-plane failures; these back off instead of pausing the project. */
  infra_failures?: number;
  infra_retry_at?: string;
  model_retry_at?: string;
  model_failures?: number;
  job_failures?: Partial<Record<"decide" | "execute" | "review", number>>;
  /**
   * A bounded review pass over findings that predate the current classification
   * and evidence rules. While set, the project is active only for Review: Decide
   * and Execute are suppressed, and the previous lifecycle is restored when no
   * review work remains.
   */
  reaudit?: { started_at: string; restore_status: "completed" | "stopped"; planning_revision: number };
  pending_completion?: {
    planning_revision?: number;
    from: string[];
    description: string;
    coverage?: CoverageEntry[];
    /** Review questions closed by this completion proposal; see ReviewIssueDisposition. */
    review_issues?: ReviewIssueDisposition[];
    graph_id: string;
    worker: string;
    observation_revision: number;
  };
}
export interface Graph {
  /** New projects and explicitly migrated copies use independent Finding classification. */
  finding_classification_version?: 1;
  /** Set on first node deletion; absent format-1 graphs contain no deletion transition. */
  node_lifecycle_version?: 1;
  /** Derived view metadata; never changes the durable source graph. */
  deleted_nodes?: DeletedNodeRef[];
  production_sources?: Record<string, { step_id: string; run_id?: string; inferred: boolean }[]>;
  inherited_asset_ids?: Record<string, string[]>;
  /** Current storage format. Old rows without this marker are rejected, never migrated. */
  format_version: 1;
  bookmarks?: Bookmark[];
  project: Project;
  revision: number;
  observation_revision: number;
  decided_revision: number;
  planning_revision?: number;
  decided_planning_revision?: number;
  last_planning_at?: string;
  last_observation_at: string;
  facts: Fact[];
  goals: Goal[];
  steps: Step[];
  /** Discovered next questions; optional on legacy graphs. */
  leads?: Lead[];
  hints: {
    id: string;
    content: string;
    creator: string;
    created_at: string;
    priority?: number;
    withdrawn_at?: string;
    /** Incremented when the human rewrites the directive; absent legacy values mean 1. */
    version?: number;
    /**
     * Model advice to defer or decline the directive. Never closes the Hint:
     * `resolved` stays unset until an operator confirms it.
     */
    notes?: { at: string; note: string; worker: string }[];
    /**
     * Operator confirmation. A Hint that no longer needs work must be closed by
     * a human; older graphs may contain model-written values, which are read as
     * closed for compatibility but never produced by new code.
     */
    resolved?: { at: string; note: string; worker: string };
    resolved_by?: "operator";
    reopened_at?: string;
  }[];
  findings: Finding[];
  assets: Asset[];
  evidence: Evidence[];
  reviews: Review[];
  usage: Usage[];
}
export interface Event {
  seq: number;
  revision: number;
  project_id: string;
  kind: string;
  data: Record<string, unknown>;
  created_at: string;
}
export interface Job {
  /** Server-produced safe snapshot; Dispatcher removes this envelope before launching the Runner. */
  worker_config?: DispatchConfig;
  kind: "decide" | "execute" | "review";
  project_id: string;
  worker: string;
  graph_id: string;
  step_id?: string;
  finding_id?: string;
  finding_version?: number;
  run_id?: string;
}
export interface Run {
  capacity?: { current: number | null; peak: number | null; generation: number; source: string };
  id: string;
  project_id: string;
  kind: Job["kind"];
  worker: string;
  /** Client-generated id of the claim that created this Run; used to cancel an abandoned claim. */
  claim_id?: string;
  graph_id: string;
  node_id: string | null;
  finding_version?: number;
  attempt: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "needs_attention";
  /** Why the Run failed. Infrastructure failures retry without pausing the project. */
  failure_kind?: "model" | "infrastructure" | "target" | "unknown";
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  external_action_possible: boolean;
  action_started_at?: string;
  session_path?: string;
  error?: string;
  /** 人工确认重试或 Step 结束时写入：失败记录保留，但不再算待人工处理。 */
  resolved_at?: string;
  resolved_by?: string;
  input: number | null;
  input_uncached?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  unknown_breakdown_request_count?: number;
  output: number | null;
  cost: number | null;
  request_count: number;
  unknown_request_count?: number;
}
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
export interface DispatchConfig {
  /** Worker-only transport override. Provider metadata keeps its original endpoint for Pi compatibility. */
  model_relay?: { base_url: string };
  server: string;
  worker_image: string;
  network: string;
  volume_prefix: string;
  max_workers: number;
  max_project_workers: number;
  /** Effective Review limit is clamped to max_project_workers. Defaults to 1 for old configs. */
  max_project_review_workers?: number;
  interval_ms: number;
  debounce_ms: number;
  /** 0 disables the task wall-clock deadline and time-triggered closeout. */
  task_timeout_seconds: number;
  closeout_seconds?: number;
  /** 0 disables the platform shell limit; the model may still supply a timeout. */
  tool_timeout_seconds?: number;
  result_repairs?: number;
  /** Injects the capture proxy into Execute runs. False keeps the original direct network path. */
  capture_enabled?: boolean;
  /**
   * Review scope. True accepts explicitly informational Findings without a
   * Review run; vulnerability and unclassified claims are always reviewed.
   */
  skip_informational_review?: boolean;
  model: import("./model-config.js").ModelConfig;
  review_model?: import("./model-config.js").ModelConfig;
}
