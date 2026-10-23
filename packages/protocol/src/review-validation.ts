import type { z } from "zod";
import type { Finding, Graph } from "./models.js";
import type { reviewSchema } from "./schemas.js";
import { scoreCvss, validateImpactEvidence } from "./cvss.js";
import { originHost } from "./coverage.js";
import { missingReportFields } from "./report-quality.js";

export class ReviewValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 409 | 422 = 422,
  ) {
    super(message);
  }
}

/** Shared semantic contract: the Runner repairs exactly the errors the server rejects. */
export function validateReviewResult(g: Graph, f: Finding, body: z.infer<typeof reviewSchema>) {
  if (body.severity != null && !body.severity_reason && !body.cvss)
    throw new Error("Review severity requires severity_reason");
  let cvss;
  if (body.cvss) {
    if (body.verdict !== "pass")
      throw new Error("Only a passing review can carry a CVSS vector; use needs_evidence instead of guessing a score");
    try {
      cvss = scoreCvss(body.cvss);
    } catch (error) {
      throw new Error(`Invalid CVSS vector: ${error instanceof Error ? error.message : "unparseable vector"}`);
    }
    try {
      validateImpactEvidence(cvss, [...f.evidence_ids, ...body.evidence_ids]);
    } catch (error) {
      throw new Error(`Invalid CVSS impact evidence: ${error instanceof Error ? error.message : "invalid proof"}`);
    }
  }
  const ids = body.verdict === "pass" ? [...f.evidence_ids, ...body.evidence_ids] : body.evidence_ids;
  if (ids.some((id) => !g.evidence.some((e) => e.id === id))) throw new Error("Unknown evidence reference");
  if (body.verdict === "pass") {
    if (!ids.length) throw new Error("Passing review requires referenced evidence");
    // A negative observation is only usable when the exact request and the
    // origin of every parameter are recorded; otherwise "not found" may just be
    // the wrong siteId, path casing or default query.
    const sourceIds = new Set(f.from);
    for (const stepId of [f.step_id, f.revision_step_id])
      if (stepId)
        for (const factId of g.steps.find((step) => step.id === stepId)?.fact_ids ?? []) sourceIds.add(factId);
    for (const fact of g.facts) {
      if (!sourceIds.has(fact.id) || fact.deleted || fact.status !== "not_observed") continue;
      // Facts created before the provenance contract remain reviewable; facts
      // written by this version always carry the marker and must satisfy it.
      if (fact.negative_claim_version !== 1) continue;
      if (!fact.request?.method?.trim() || !fact.request.url?.trim())
        throw new Error(
          `Negative observation ${fact.id} lacks request/parameter_sources; record the exact request and where each parameter came from before passing, or return needs_evidence`,
        );
      const parameters = requestParameters(fact.request.url, originHost(g));
      if (parameters.length && !fact.parameter_sources?.length)
        throw new Error(
          `Negative observation ${fact.id} lacks request/parameter_sources; record the exact request and where each parameter came from before passing, or return needs_evidence`,
        );
      const sourced = new Set(
        (fact.parameter_sources ?? []).map((source) =>
          source.parameter
            .trim()
            .replace(/^[?&]+/, "")
            .split("=", 1)[0]
            .trim(),
        ),
      );
      const missing = parameters.filter((parameter) => !sourced.has(parameter));
      if (missing.length)
        throw new Error(
          `Negative observation ${fact.id} does not explain where these request parameters came from: ${missing.join(", ")}; add a parameter_sources entry for each or return needs_evidence`,
        );
    }
    if (body.disputed_fact_ids.length) throw new Error("Passing review cannot dispute source observations");
    if (!body.kind) throw new Error("Passing review requires explicit kind=vulnerability or kind=informational");
    if (body.kind === "vulnerability") {
      if (!cvss || cvss.score <= 0)
        throw new Error(
          "Passing a vulnerability review requires a CVSS v4.0 vector with a positive score and impact evidence",
        );
      const missing = missingReportFields(f);
      if (missing.length)
        throw new Error(
          `Vulnerability pass requires report fields: ${missing.join(", ")}. Use needs_evidence with the missing fields; ask Decide to revise with finding_updates, then re-review.`,
        );
    }
  }
  for (const id of body.disputed_fact_ids) {
    if (id === "origin" || !f.from.includes(id))
      throw new Error("Only explicitly contradicted source observations can be disputed");
    if (g.facts.some((fact) => fact.id === id && fact.deleted))
      throw new ReviewValidationError(
        "Source Fact deleted; omit it from disputed_fact_ids and use explicit history",
        409,
      );
  }
  if (body.kind === "informational" && (cvss || (body.severity && body.severity !== "informational")))
    throw new Error("Informational reviews have no severity or CVSS; use kind=informational and omit ratings");
  return cvss;
}

/** Query parameter names that a negative claim must be able to justify. */
function requestParameters(raw: string, origin: string): string[] {
  let url: URL;
  try {
    url = new URL(raw, origin ? `https://${origin}/` : undefined);
  } catch {
    throw new Error(`Negative observation request URL is not parseable: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Negative observation request URL must use http(s): ${raw}`);
  return [...new Set([...url.searchParams.keys()])];
}
