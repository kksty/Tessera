import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { Store, DomainError } from "../../packages/core/src/store.js";
import { decideSchema, submitDecisionsSchema, reviewSchema, type Finding } from "../../packages/protocol/src/index.js";

/** Exercise the current two-phase decision submission from compact test fixtures. */
export function commitPlan(store: Store, id: string, body: z.infer<typeof decideSchema>) {
  const response = store.submitDecisions(id, submitDecisionsSchema.parse({ ...body, submission_id: randomUUID() }));
  if (!response.settle.ok) throw new DomainError(409, response.settle.conflicts.map(c => c.reason).join("; "));
  return store.get(id);
}

/** Seed a reviewed fixture through the real Review validator, never an operator approval API. */
export function recordReview(store: Store, id: string, fid: string, status: "confirmed" | "rejected", reviewer: string, reason: string, kind?: Finding["kind"]) {
  const finding = store.get(id).findings.find(f => f.id === fid);
  if (!finding) throw new DomainError(404, "Finding not found");
  const worker = finding.review_worker || reviewer;
  if (!finding.review_worker) store.mutate(id, "", false, graph => { graph.findings.find(f => f.id === fid)!.review_worker = worker; });
  const rating = finding.cvss;
  store.review(id, fid, reviewSchema.parse({ worker, finding_version: finding.version, kind: kind ?? finding.kind,
    verdict: status === "confirmed" ? "pass" : "rejected", reason, evidence_ids: finding.evidence_ids,
    ...(status === "confirmed" && rating ? { cvss: { vector: rating.vector, rationale: rating.rationale, impact_evidence: rating.impact_evidence } } : {}) }));
  return store.get(id).findings.find(f => f.id === fid)!;
}
