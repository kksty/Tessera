import { modelIssue } from "./model-errors.js";

/**
 * Why a Run ended. The distinction that matters operationally is whether the
 * control plane failed (retry, never pause the project) or the work itself
 * failed (count it against the project).
 */
export type FailureKind = "model" | "infrastructure" | "target" | "unknown";

const infrastructurePatterns = [
  /lease expired/i,
  /claim response abandoned/i,
  /diagnostic server delivery failed/i,
  /client disconnect/i,
  /aborted due to timeout/i,
  /socket hang up/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EHOSTUNREACH/,
  /network error|fetch failed/i,
];

/**
 * A Worker that cannot reach the server has not failed at the task. Those
 * failures must back off and retry instead of counting towards the three
 * failures that pause a project. A model-provider error is never classified as
 * infrastructure even when its text mentions a socket or a timeout.
 */
export function classifyFailure(raw?: string, explicit?: FailureKind): FailureKind {
  if (explicit) return explicit;
  const text = raw?.trim();
  if (!text) return "unknown";
  if (modelIssue(text)) return "model";
  if (infrastructurePatterns.some((pattern) => pattern.test(text))) return "infrastructure";
  return "unknown";
}

export function infrastructureIssue(raw?: string): boolean {
  return classifyFailure(raw) === "infrastructure";
}

/** 5s → 300s, capped; the project stays active while the control plane recovers. */
export function infrastructureBackoff(failures: number): string {
  const delay = Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failures - 1)));
  return new Date(Date.now() + delay).toISOString();
}

export const FAILURE_LABELS: Record<FailureKind, string> = {
  model: "模型",
  infrastructure: "基础设施",
  target: "目标",
  unknown: "未知",
};
