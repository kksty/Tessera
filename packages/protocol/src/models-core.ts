import type { z } from "zod";
import type { factStatusSchema, coverageEntrySchema } from "./schemas.js";
import type { TestDomain } from "./domains.js";
import { CompletionRecord, Finding, Review } from "./models-finding.js";

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

/**
 * Boundary of a negative observation. A failed attempt proves only what was
 * attempted inside this scope; it does not prove the direction is exhausted.
 */
export interface NegativeScope {
  /** Concrete attempts: requests, payload sets, tools, wordlists, repetition. */
  attempted: string[];
  /** Known gaps outside this attempt. */
  not_tested?: string[];
  /** How far the negative result generalizes; high still needs a broad attempt. */
  confidence: "low" | "medium" | "high";
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
  /** Boundary of a negative result; required for new not_observed facts. */
  negative_scope?: NegativeScope;
  /**
   * Version 1 requires request provenance; version 2 also requires scope.
   * Facts without a marker predate both contracts.
   */
  negative_claim_version?: 1 | 2;
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
  field: "description" | "property" | "method_hint" | "conclusion" | "request" | "parameter_sources" | "negative_scope";
  /** The replaced text. A first-time provenance addition has nothing to replace. */
  from?: string;
}
