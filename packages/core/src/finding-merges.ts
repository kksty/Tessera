import type { Finding, Graph, Run, decideSchema } from "../../protocol/src/index.js";
import type { z } from "zod";
import { normalizeFindingIdentity } from "../../protocol/src/finding-identity.js";
import { stepAssets } from "../../protocol/src/asset-scope.js";
import { digest } from "./execution.js";

export type FindingMerge = z.infer<typeof decideSchema>["finding_merges"][number];
export type FindingUpdate = z.infer<typeof decideSchema>["finding_updates"][number];

export function archiveFinding(finding: Finding, worker: string, reason: string) {
  const { title, description, evidence, evidence_ids, from, severity, severity_reason, impact,
    reproduction, remediation, identity, cvss, kind } = finding;
  (finding.edits ??= []).push({ at: new Date().toISOString(), editor: worker, reason, version: finding.version,
    previous: structuredClone({ title, description, evidence, evidence_ids, from, kind, severity, severity_reason,
      impact, reproduction, remediation, identity, cvss }) });
}

export function findingUpdateConflicts(graph: Graph, updates: FindingUpdate[]) {
  return updates.flatMap(input => {
    const finding = graph.findings.find(f => f.id === input.id);
    const reason = !finding ? "Finding not found" : finding.deleted ? "Finding deleted" : finding.merged_into ? `Finding merged into ${finding.merged_into}`
      : finding.withdrawn_at && !input.restore ? "Finding withdrawn; use restore:true with new supporting material"
      : input.restore && !finding.withdrawn_at ? "Only withdrawn Findings can be restored"
      : input.restore && !Object.keys(input.changes).length ? "Restoring requires revised claims or supporting evidence"
      : input.restore && Object.entries(input.changes).every(([key, value]) => digest(value) === digest(finding[key as keyof Finding]))
        ? "Restoring requires changed claims or new supporting evidence"
      : finding.version !== input.expected_version ? `Finding version changed (expected ${input.expected_version}, current ${finding.version})`
      : input.changes.from?.some(id => !graph.facts.some(f => f.id === id && !f.deleted)) ? "Invalid source Fact"
      : input.changes.evidence_ids?.some(id => !graph.evidence.some(e => e.id === id)) ? "Unknown evidence" : undefined;
    return reason ? [{ kind: "finding_update" as const, id: input.id, reason }] : [];
  });
}

export function applyFindingUpdates(graph: Graph, updates: FindingUpdate[], worker: string,
  endRun: (graph: Graph, worker: string, status: Run["status"], error?: string, runId?: string) => void) {
  for (const input of updates) {
    const finding = graph.findings.find(f => f.id === input.id)!;
    const changes = { ...input.changes,
      ...(input.changes.identity ? { identity: normalizeFindingIdentity(input.changes.identity) } : {}) };
    if (!input.withdraw && !input.restore && Object.entries(changes).every(([key, value]) => digest(value) === digest(finding[key as keyof Finding]))) continue;
    archiveFinding(finding, worker, input.reason);
    if (finding.review_worker) endRun(graph, finding.review_worker, "cancelled", "Finding revised by Decide", finding.review_run_id);
    Object.assign(finding, changes, { version: finding.version + 1, status: "candidate", review_status: "pending",
      severity: null, severity_reason: null, cvss: null, severity_before_review: undefined,
      severity_reason_before_review: undefined, review_worker: null, review_heartbeat: null,
      review_run_id: undefined, retry_at: undefined, last_referenced_round: graph.project.decision_round ?? 0 });
    if (input.withdraw) Object.assign(finding, { status: "rejected", review_status: "rejected",
      reviewed_version: finding.version, withdrawn_at: new Date().toISOString(), withdrawn_by: worker,
      withdrawal_reason: input.reason });
    if (input.restore) Object.assign(finding, { withdrawn_at: undefined, withdrawn_by: undefined,
      withdrawal_reason: undefined });
  }
}

export function duplicateFindingGroups(findings: Finding[]) {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.deleted || !finding.identity || finding.merged_into || finding.status === "rejected") continue;
    const fingerprint = digest(normalizeFindingIdentity(finding.identity));
    groups.set(fingerprint, [...groups.get(fingerprint) ?? [], finding]);
  }
  return [...groups].filter(([, members]) => members.length > 1)
    .map(([fingerprint, members]) => ({ fingerprint, finding_ids: members.map(f => f.id) }));
}

/** Shared entry points flag semantic comparison, never authorize an automatic merge. */
export function relatedFindingGroups(findings: Finding[]) {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.deleted || finding.merged_into || finding.withdrawn_at || finding.status === "rejected" || !finding.identity) continue;
    const identity = normalizeFindingIdentity(finding.identity);
    const entry = identity.path || identity.location;
    if (!entry) continue;
    const fingerprint = digest({ graph_id: finding.graph_id, asset_id: finding.asset_id ?? null,
      host: identity.host, protocol: identity.protocol, port: identity.port, method: identity.method, entry });
    groups.set(fingerprint, [...groups.get(fingerprint) ?? [], finding]);
  }
  return [...groups].filter(([, members]) => members.length > 1 &&
    new Set(members.map(f => digest(normalizeFindingIdentity(f.identity!)))).size > 1)
    .map(([fingerprint, members]) => ({ fingerprint, match: "endpoint" as const, finding_ids: members.map(f => f.id) }));
}

/** Preflight the entire settlement before changing nodes or cancelling leases. */
export function findingMergeConflicts(graph: Graph, merges: FindingMerge[]) {
  const conflicts: { kind: "finding_merge"; id: string; reason: string }[] = [];
  const used = new Set<string>();
  for (const merge of merges) {
    const target = graph.findings.find(f => f.id === merge.target_id);
    for (const id of [merge.target_id, ...merge.source_ids]) {
      const finding = graph.findings.find(f => f.id === id);
      let reason: string | undefined;
      if (used.has(id)) reason = "Each Finding can occur only once in a merge batch";
      else if (!finding) reason = "Finding not found";
      else if (finding.deleted) reason = "Finding deleted";
      else if (finding.merged_into) reason = `Finding already merged into ${finding.merged_into}`;
      else if (finding.withdrawn_at) reason = "Finding withdrawn";
      else if (finding.human_feedback && finding.reviewed_version <= finding.human_feedback.version)
        reason = "Resolve the operator feedback on the original Finding ID before merging";
      else if (finding.version !== merge.expected_versions[id]) reason = `Finding version changed (expected ${merge.expected_versions[id]}, current ${finding.version})`;
      else if (target && (finding.graph_id !== target.graph_id ||
        digest(stepAssets(graph, finding).sort()) !== digest(stepAssets(graph, target).sort()) ||
        (finding.identity && target.identity && normalizeFindingIdentity(finding.identity).host !== normalizeFindingIdentity(target.identity).host)))
        reason = "Cannot merge findings across different assets or graphs";
      if (reason) conflicts.push({ kind: "finding_merge", id, reason });
      used.add(id);
    }
  }
  return conflicts;
}

export function applyFindingMerges(graph: Graph, merges: FindingMerge[], worker: string,
  endRun: (graph: Graph, worker: string, status: Run["status"], error?: string, runId?: string) => void) {
  for (const merge of merges) {
    const target = graph.findings.find(f => f.id === merge.target_id)!;
    const sources = merge.source_ids.map(id => graph.findings.find(f => f.id === id)!);
    for (const finding of [target, ...sources]) {
      archiveFinding(finding, worker, merge.reason);
      if (finding.review_worker) endRun(graph, finding.review_worker, "cancelled", "Finding merged by Decide", finding.review_run_id);
      finding.review_worker = null;
      finding.review_heartbeat = null;
      finding.review_run_id = undefined;
      finding.retry_at = undefined;
      finding.version++;
    }
    target.from = [...new Set([target, ...sources].flatMap(f => f.from))];
    target.evidence_ids = [...new Set([target, ...sources].flatMap(f => f.evidence_ids))];
    // Conflicting ratings are not settled by choosing max/min or copying a pass.
    // Review reads all retained source records and evaluates the merged version.
    target.status = "candidate";
    target.review_status = "pending";
    target.cvss = null;
    target.severity = null;
    target.severity_reason = null;
    target.severity_before_review = undefined;
    target.severity_reason_before_review = undefined;
    target.last_referenced_round = graph.project.decision_round ?? 0;
    for (const source of sources) {
      source.merged_into = target.id;
      source.merge_reason = merge.reason;
      source.merged_at = new Date().toISOString();
      source.merged_by = worker;
      source.status = "rejected";
      source.review_status = "rejected";
      source.reviewed_version = source.version;
    }
  }
}

/** Include the complete lineage when merged targets are later merged again. */
export function mergedFindingSources(graph: Graph, targetId: string): Finding[] {
  const ids = new Set([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const finding of graph.findings)
      if (!finding.deleted && finding.merged_into && ids.has(finding.merged_into) && !ids.has(finding.id)) {
        ids.add(finding.id); changed = true;
      }
  }
  return graph.findings.filter(f => f.id !== targetId && ids.has(f.id));
}
