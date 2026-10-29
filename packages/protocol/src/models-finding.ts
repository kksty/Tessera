import type { z } from "zod";
import type { findingIdentitySchema, reproductionSchema, cvssSchema } from "./schemas.js";
import { CooldownOverride, CoverageEntry, Fact, NodeDeletion, Step } from "./models-core.js";
import { Job } from "./models-project.js";

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
