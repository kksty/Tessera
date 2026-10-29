import { Bookmark, CoverageEntry, DeletedNodeRef, Fact, Goal, Step } from "./models-core.js";
import {
  Asset,
  CompletionRecord,
  Evidence,
  Finding,
  Lead,
  ReasonLease,
  Review,
  ReviewIssueDisposition,
  Usage,
} from "./models-finding.js";
import { Peer, ProjectMode, SwarmRound } from "./models-swarm.js";
import { DispatchConfig } from "./models-config.js";

export interface Project {
  deletion?: { id: string; requested_at: string; volume_prefix: string; error?: string };
  /** Docker volume prefix used when this project's worker was first created. */
  volume_prefix?: string;
  id: string;
  title: string;
  status: "active" | "stopped" | "completed";
  created_at: string;
  /** 任务架构模式；缺省为 classic。创建时选定，不可中途切换。 */
  mode?: ProjectMode;
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
  /**
   * 按任务类别累计连续业务失败；swarm 的 peer 进一步按执行者分桶，
   * 键形如 `peer:<peer_id>`，避免一个执行者的失败牵连同侪。
   */
  job_failures?: Partial<Record<string, number>>;
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
  /**
   * 完成的持久记录。classic 把同一份记录写在合成的“完成任务”Step 上；
   * swarm 没有 Step，覆盖表与审核问题处置保存在项目本身。
   */
  completion?: CompletionRecord;
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
     * Closure of the directive. An operator closes it from the hint panel; the
     * Decider may also close it by returning a `hint_notes` entry that states how
     * the directive was carried out (resolved_by: "decide"). The operator can still
     * reopen any Hint a model closed.
     */
    resolved?: { at: string; note: string; worker: string };
    resolved_by?: "operator" | "decide";
    reopened_at?: string;
  }[];
  findings: Finding[];
  assets: Asset[];
  evidence: Evidence[];
  reviews: Review[];
  usage: Usage[];
  /** swarm 模式的平等执行者；classic 项目始终为空。 */
  peers?: Peer[];
  /** swarm 完成共识轮次；classic 项目始终为空。 */
  rounds?: SwarmRound[];
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
  kind: "decide" | "execute" | "review" | "peer";
  project_id: string;
  worker: string;
  graph_id: string;
  step_id?: string;
  finding_id?: string;
  finding_version?: number;
  run_id?: string;
  /** swarm 模式：本回合运行的 peer。 */
  peer_id?: string;
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
  /**
   * swarm 轮次的终局已写入（POST /fgs/peers/:peer/turn-end）。回合租约要到
   * Worker 退出后的 release 才结束（避免同一执行者两回合并行），release 见到
   * 该标记就把 Run 记为 succeeded，而不是普通的 cancelled。
   */
  peer_turn_ended_at?: string;
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
