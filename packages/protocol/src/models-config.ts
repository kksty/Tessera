import { Step } from "./models-core.js";
import { Finding, Review } from "./models-finding.js";

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
  /**
   * Bounded repair rounds for a final result that fails the job protocol (0–3).
   * Defaults to 2: a schema-shaped answer is a serialization miss, not a new task.
   */
  result_repairs?: number;
  /** Injects the capture proxy into Execute runs. False keeps the original direct network path. */
  capture_enabled?: boolean;
  /**
   * Review scope. True accepts explicitly informational Findings without a
   * Review run; vulnerability and unclassified claims are always reviewed.
   */
  skip_informational_review?: boolean;
  /**
   * Planning budget. New Steps a single Decide round may create (0 = unlimited,
   * default 2). Merging a near-duplicate into an existing Step does not count.
   */
  max_new_steps_per_round?: number;
  /** Open (unclosed, not discarded) Steps a project may hold before Decide must close, discard or wait (0 = unlimited, default 8). */
  max_open_steps?: number;
  model: import("./model-config.js").ModelConfig;
  review_model?: import("./model-config.js").ModelConfig;
  /** Feishu (Lark) webhook notifications for operator-facing events. */
  notifications?: NotificationConfig;
}

/**
 * Feishu bot notifications. The webhook is a secret-bearing URL: it is stored on
 * the server and never echoed back verbatim. Each switch gates one event family.
 */
export interface NotificationConfig {
  /** Full Feishu bot webhook URL; empty disables all delivery. */
  feishu_webhook?: string;
  /** Send a message whenever a new Finding is submitted. */
  notify_new_finding?: boolean;
  /** Send a message when work needs a human (pending review / assets / errors). */
  notify_needs_human?: boolean;
}
