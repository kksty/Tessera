import type { z } from "zod";
import type { Finding, Graph } from "./models.js";
import { negativeScopeSchema, type reviewSchema } from "./schemas.js";
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
    // Only the Finding's declared sources gate the review. Facts produced by the
    // same Step stay readable to the reviewer but are not implicitly attributed
    // to this claim: otherwise one unrelated negative observation can make a
    // complete Finding impossible to pass, no matter how often it is revised.
    const sourceIds = new Set(f.from);
    for (const fact of g.facts) {
      if (!sourceIds.has(fact.id) || fact.deleted || fact.status !== "not_observed") continue;
      // Facts created before the provenance contract remain reviewable; facts
      // written by this version always carry the marker and must satisfy it.
      if (fact.negative_claim_version !== 1 && fact.negative_claim_version !== 2) continue;
      if (!fact.request?.method?.trim() || !fact.request.url?.trim())
        throw new Error(
          `Negative observation ${fact.id} lacks request/parameter_sources; record the exact request and where each parameter came from before passing, or return needs_evidence`,
        );
      const parameters = requestParameters(fact.request.url, originHost(g));
      if (parameters.length && !fact.parameter_sources?.length)
        throw new Error(
          `Negative observation ${fact.id} lacks request/parameter_sources; record the exact request and where each parameter came from before passing, or return needs_evidence`,
        );
      const known = new Set(parameters);
      const sourced = new Set<string>();
      for (const source of fact.parameter_sources ?? []) {
        const matched = requestedParameter(source.parameter, known);
        if (matched) sourced.add(matched);
      }
      const missing = parameters.filter((parameter) => !sourced.has(parameter));
      if (missing.length)
        throw new Error(
          `Negative observation ${fact.id} does not explain where these request parameters came from: ${missing.join(", ")}; add one parameter_sources entry per exact URL-decoded parameter name (names may contain "=" or quotes)`,
        );
      if (fact.negative_claim_version === 2 && !negativeScopeSchema.safeParse(fact.negative_scope).success)
        throw new Error(
          `Negative observation ${fact.id} lacks negative_scope: record what was attempted, what remains untested and confidence; a single attempt does not prove the direction is exhausted`,
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

/**
 * Submission-time contract for a negative claim, checked when the Fact is
 * written rather than weeks later at Review. Returns the problem text, or
 * undefined when the claim carries a parseable request, one provenance entry
 * per URL parameter, and (for new-contract facts) a bounded negative scope.
 */
export function negativeClaimProblem(
  claim: {
    request?: { method?: string; url?: string };
    parameter_sources?: readonly { parameter: string }[];
    negative_scope?: { attempted?: readonly string[]; confidence?: string };
    conclusion?: string;
    description?: string;
  },
  origin: string,
  options: { requireScope?: boolean } = {},
): string | undefined {
  if (!claim.request?.method?.trim() || !claim.request.url?.trim())
    return "negative claim lacks request: record the exact request (method/url) that produced it";
  let parameters: string[];
  try {
    parameters = requestParameters(claim.request.url, origin);
  } catch (error) {
    return error instanceof Error ? error.message : "negative claim request URL is not parseable";
  }
  if (parameters.length && !claim.parameter_sources?.length)
    return "negative claim lacks parameter_sources: one entry per exact URL-decoded parameter name";
  const known = new Set(parameters);
  const sourced = new Set<string>();
  for (const source of claim.parameter_sources ?? []) {
    const matched = requestedParameter(source.parameter, known);
    if (matched) sourced.add(matched);
  }
  const missing = parameters.filter((parameter) => !sourced.has(parameter));
  if (missing.length)
    return `negative claim does not explain where these request parameters came from: ${missing.join(", ")}; add one parameter_sources entry per exact URL-decoded parameter name (names may contain "=" or quotes)`;
  if (options.requireScope) {
    if (!claim.negative_scope?.attempted?.length)
      return "negative claim lacks negative_scope: record attempted attempts, not_tested gaps and confidence (low/medium/high); a single request does not prove the direction is exhausted";
    if (!negativeScopeSchema.safeParse(claim.negative_scope).success)
      return "negative claim negative_scope is invalid: attempted/not_tested must contain bounded nonempty strings and confidence must be low, medium or high";
  }
  return undefined;
}

/**
 * Match one provenance entry to an actual request parameter name. An injected
 * parameter name may itself contain "=" (for example
 * `<script>document.title='P1'</script>`), so never split at the first "=" in a
 * way that truncates a legitimate name. Exact matches win; a `name=value` form
 * is accepted only when the prefix is one of the request's parameters.
 */
export function requestedParameter(raw: string, known: Set<string>): string | undefined {
  const value = raw.trim().replace(/^[?&]+/, "");
  if (!value) return undefined;
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {
    // A malformed escape is just not a match; it cannot become a parameter name.
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
    const separator = candidate.indexOf("=");
    if (separator <= 0) continue;
    const name = candidate.slice(0, separator).trim();
    if (known.has(name)) return name;
  }
  return undefined;
}

/** Query parameter names that a negative claim must be able to justify. */
export function requestParameters(raw: string, origin: string): string[] {
  let url: URL;
  try {
    url = new URL(raw, origin ? `https://${origin}/` : undefined);
  } catch {
    throw new Error(`Negative observation request URL is not parseable: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Negative observation request URL must use http(s): ${raw}`);
  return [...new Set([...url.searchParams.keys()])];
}
