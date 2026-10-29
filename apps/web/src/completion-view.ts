import { coverageSurfaces, normalizeSurface, originHost } from "../../../packages/protocol/src/coverage.js";
import type { CoverageEntry, Graph, Step } from "../../../packages/protocol/src/index.js";

export type CoverageStatus = CoverageEntry["status"] | "unrecorded";

export interface CoverageRow {
  key: string;
  surface: string;
  parameter?: string;
  status: CoverageStatus;
  reason?: string;
  evidence_ids: string[];
  fact_ids: string[];
  /** Whether the current graph still observes this surface. */
  observed: boolean;
}

export interface CompletionSnapshot {
  entries: CoverageEntry[];
  /** The proposal still waiting for its gates, or undefined once completed. */
  pending: boolean;
  step?: Step;
  /** swarm 把完成记录保存在 project.completion 上，没有合成的完成 Step。 */
  project_record?: boolean;
}

/**
 * The accepted coverage table has two durable homes: classic writes a synthetic
 * completion Step, swarm keeps the same record on the project (it has no Steps).
 * `finalizeCompletion` clears `pending_completion`, so reading only that field
 * would lose the table the moment the project completes.
 */
export function latestCompletionStep(graph: Graph): Step | undefined {
  for (let index = graph.steps.length - 1; index >= 0; index -= 1) {
    const step = graph.steps[index];
    if (step.deleted || step.discarded || step.to !== "goal") continue;
    return step;
  }
  return undefined;
}

export function completionSnapshot(graph: Graph): CompletionSnapshot {
  const pending = graph.project.pending_completion;
  if (pending) return { entries: pending.coverage ?? [], pending: true };
  if (graph.project.status !== "completed") return { entries: [], pending: false };
  if (graph.project.completion)
    return { entries: graph.project.completion.coverage ?? [], pending: false, project_record: true };
  const step = latestCompletionStep(graph);
  return { entries: step?.completion?.coverage ?? [], pending: false, step };
}

/**
 * Merge the recorded disposition per surface with the surfaces the graph still
 * observes. Recorded rows keep model-supplied wording (absolute URLs are
 * normalized for joining); observed-but-unrecorded rows are shown instead of
 * hidden, which keeps legacy projects readable without inventing a status.
 */
export function coverageRows(graph: Graph, entries: CoverageEntry[]): CoverageRow[] {
  const observed = new Map(coverageSurfaces(graph).map((item) => [item.surface, item]));
  const rows = new Map<string, CoverageRow>();
  const recordedSurfaces = new Set<string>();
  for (const entry of entries) {
    const surface = normalizeSurface(entry.surface, originHost(graph), true) ?? entry.surface.trim();
    const parameter = entry.parameter?.trim() || undefined;
    const key = `${surface}\u0000${parameter ?? ""}`;
    if (rows.has(key)) continue;
    recordedSurfaces.add(surface);
    rows.set(key, {
      key,
      surface,
      parameter,
      status: entry.status,
      reason: entry.reason?.trim() || undefined,
      evidence_ids: entry.evidence_ids ?? [],
      fact_ids: observed.get(surface)?.fact_ids ?? [],
      observed: observed.has(surface),
    });
  }
  for (const [surface, item] of observed) {
    if (recordedSurfaces.has(surface)) continue;
    rows.set(`observed:${surface}`, {
      key: `observed:${surface}`,
      surface,
      status: "unrecorded",
      evidence_ids: item.evidence_ids,
      fact_ids: item.fact_ids,
      observed: true,
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.surface.localeCompare(right.surface) || (left.parameter ?? "").localeCompare(right.parameter ?? ""),
  );
}

export function coverageCounts(rows: CoverageRow[]) {
  const count = (status: CoverageStatus) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    tested: count("tested"),
    waived: count("waived"),
    na: count("na"),
    unrecorded: count("unrecorded"),
  };
}
