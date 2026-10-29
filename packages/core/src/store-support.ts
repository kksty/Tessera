import { fail } from "./errors.js";
import { type StepDraft } from "./step-similarity.js";
import { domainToASCII } from "node:url";
import { modelIssue } from "../../protocol/src/model-errors.js";
import type { Job } from "../../protocol/src/index.js";

export const now = () => new Date().toISOString();

export const DECIDE_MAX_BATCH_WAIT_MS = 30000;

export const expired = (timestamp: string | null | undefined, seconds: number) =>
  !timestamp || Date.now() - Date.parse(timestamp) > seconds * 1000;

export const ready = (timestamp: string | undefined) => !timestamp || Date.parse(timestamp) <= Date.now();

export const executeCapacityFailure = (error?: string) =>
  modelIssue(error)?.kind === "context" ||
  /^(?:Closeout budget exhausted|Read-only recovery closeout timeout)/i.test(error || "");

export const jobFailureKey = (kind: Job["kind"], peerId?: string | null) =>
  kind === "peer" && peerId ? `peer:${peerId}` : kind;

export const metadataFields = new Set([
  "last_referenced_round",
  "last_read_round",
  "cooldown_override",
  // swarm 持久身份与共识轮次的变化通过显式事件与显式唤醒驱动，不参与图版本推进，
  // 否则每次表态/开轮都会唤醒所有 peer。仍会正常持久化（GraphStorage.save 全量写）。
  "peers",
  "rounds",
]);

export const material = (value: unknown) =>
  JSON.stringify(value, (key, item) => (metadataFields.has(key) ? undefined : item));

export function hostname(value: string): string {
  const raw = value.trim().replace(/^\*\./, "");
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return fail(422, "Invalid hostname");
  }
  host = domainToASCII(host.replace(/\.$/, "")).toLowerCase();
  if (!host || host.includes("/") || host.length > 253) return fail(422, "Invalid hostname");
  return host;
}

export const collections = [
  "facts",
  "goals",
  "steps",
  "leads",
  "hints",
  "findings",
  "assets",
  "evidence",
  "reviews",
  "usage",
  "bookmarks",
  "peers",
  "rounds",
] as const;

export type StepInsert = StepDraft & { hint_ids?: string[]; lead_ids?: string[] };
