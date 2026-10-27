import type { Finding, Graph, NodeDeletion, Run, decideSchema } from "../../protocol/src/index.js";
import { humanApproved } from "../../protocol/src/finding-policy.js";
import { graphNodeKinds, isActiveNode } from "../../protocol/src/node-lifecycle.js";
import { resolveGraphRelations } from "../../protocol/src/graph-relations.js";
import type { z } from "zod";
import { digest } from "./execution.js";

type DeleteInput = z.infer<typeof decideSchema>["delete_nodes"][number];
export interface DeletionConflict {
  kind: "delete";
  id?: string;
  reason: string;
}

/**
 * Expand only explicit downstream business dependencies; never Evidence/asset/keyword affinity.
 * Decide cannot discard a Finding the operator approved for its current version: approval is
 * version-bound, so the operator owns withdrawal and deletion while the model may still revise
 * the claim into a new version for Review.
 */
export function planNodeDeletions(graph: Graph, inputs: DeleteInput[], options: { protectApproved?: boolean } = {}) {
  const protectApproved = options.protectApproved !== false;
  const nodes = new Map(
    graphNodeKinds.flatMap((kind) => graph[kind].map((node) => [node.id, { kind, node }] as const)),
  );
  const index = resolveGraphRelations(graph);
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  const link = (source: string, target: string) => {
    const values = children.get(source) ?? new Set<string>();
    values.add(target);
    children.set(source, values);
    const sources = parents.get(target) ?? new Set<string>();
    sources.add(source);
    parents.set(target, sources);
  };
  for (const edge of index.relations)
    if (["step_input", "fact_production", "finding_source", "finding_production"].includes(edge.kind))
      link(edge.source, edge.target);
  for (const step of graph.steps) if (step.goal_id) link(step.goal_id, step.id);
  const selected = new Map<
    string,
    {
      kind: (typeof graphNodeKinds)[number];
      node:
        | (typeof graph.facts)[number]
        | (typeof graph.steps)[number]
        | (typeof graph.findings)[number]
        | (typeof graph.goals)[number];
      input: DeleteInput;
    }
  >();
  const conflicts: DeletionConflict[] = [];
  const roots = new Set<string>();
  for (const input of inputs) {
    const root = nodes.get(input.id);
    if (roots.has(input.id)) {
      conflicts.push({ kind: "delete", id: input.id, reason: "Duplicate deletion ID" });
      continue;
    }
    roots.add(input.id);
    if (["origin", "goal"].includes(input.id) || !root) {
      conflicts.push({
        kind: "delete",
        id: input.id,
        reason:
          "Only Fact, Step, Finding and model subgoals may be deleted; task and historical records use their own lifecycle",
      });
      continue;
    }
    if (!isActiveNode(root.node)) {
      conflicts.push({ kind: "delete", id: input.id, reason: "Node is already deleted; read explicit history" });
      continue;
    }
    const queue = [input.id],
      visited = new Set<string>();
    for (let offset = 0; offset < queue.length; offset++) {
      const id = queue[offset];
      if (visited.has(id)) continue;
      visited.add(id);
      const item = nodes.get(id);
      if (!item || !isActiveNode(item.node) || id === "origin" || id === "goal") continue;
      if (protectApproved && item.kind === "findings" && humanApproved(item.node as Finding)) {
        conflicts.push({
          kind: "delete",
          id,
          reason: "Operator-approved Finding; only the operator can withdraw or delete it",
        });
        continue;
      }
      if (!selected.has(id)) selected.set(id, { ...item, input });
      if (input.cascade === "downstream") queue.push(...(children.get(id) ?? []));
    }
  }
  const ids = new Set(selected.keys());
  const affected = [...nodes.values()]
    .filter(
      ({ node }) =>
        isActiveNode(node) &&
        !ids.has(node.id) &&
        (("from" in node && node.from.some((id) => ids.has(id))) ||
          ("fact_ids" in node && node.fact_ids.some((id) => ids.has(id))) ||
          ("step_id" in node && !!node.step_id && ids.has(node.step_id)) ||
          ("revision_step_id" in node && !!node.revision_step_id && ids.has(node.revision_step_id)) ||
          ("goal_id" in node && !!node.goal_id && ids.has(node.goal_id)) ||
          index.facts.get(node.id)?.producers.some((producer) => ids.has(producer.step_id))),
    )
    .map(({ node }) => node.id)
    .sort();
  return {
    entries: [...selected.values()].sort((a, b) => a.node.id.localeCompare(b.node.id)),
    ids,
    affected,
    conflicts,
    parents,
  };
}

type DeletionPlan = ReturnType<typeof planNodeDeletions>;
function cancellationFor({ kind, node }: DeletionPlan["entries"][number]) {
  if (kind === "steps" && "worker" in node && node.worker && node.run_id)
    return { node_id: node.id, kind: "execute" as const, worker: node.worker, run_id: node.run_id };
  if (kind === "findings" && "review_worker" in node && node.review_worker && node.review_run_id)
    return { node_id: node.id, kind: "review" as const, worker: node.review_worker, run_id: node.review_run_id };
}

/** Pure read: no leases, indexes, events, read clocks or decided watermarks change. */
export function previewNodeDeletions(graph: Graph, inputs: DeleteInput[], plan = planNodeDeletions(graph, inputs)) {
  const roots = new Set(inputs.map((input) => input.id));
  const active = new Set(graphNodeKinds.flatMap((kind) => graph[kind].filter(isActiveNode).map((node) => node.id)));
  const nodes = plan.entries.map(({ kind, node, input }) => ({
    id: node.id,
    kind,
    root_id: input.id,
    cascade: input.cascade,
    retained_dependencies: [...(plan.parents.get(node.id) ?? [])]
      .filter((id) => active.has(id) && !plan.ids.has(id))
      .sort(),
  }));
  const cancelled = plan.entries.flatMap((entry) => {
    const run = cancellationFor(entry);
    return run ? [run] : [];
  });
  const impact = {
    deleted: [...plan.ids].sort(),
    affected: plan.affected,
    cancelled_runs: [...new Set(cancelled.map((run) => run.run_id))].sort(),
    shared_descendants: nodes
      .filter((node) => !roots.has(node.id) && node.retained_dependencies.length)
      .map((node) => ({ id: node.id, retained_dependencies: node.retained_dependencies })),
    nodes,
    cancellations: cancelled,
  };
  return {
    snapshot_revision: graph.revision,
    observation_revision: graph.observation_revision,
    valid: !plan.conflicts.length,
    conflicts: plan.conflicts,
    ...impact,
    impact_hash: digest({ project_id: graph.project.id, delete_nodes: inputs, ...impact }),
    effects: {
      descendants_with_other_sources_are_deleted: true,
      cancelled_external_requests_may_already_have_executed: true,
      originals_and_evidence_retained: true,
      deleted_findings_can_be_restored_by_operator: true,
      deleted_facts_steps_goals_can_be_restored: false,
      single_fact_deletion_invalidates_other_finding_passes: false,
    },
  };
}
export type DeletionPreview = ReturnType<typeof previewNodeDeletions>;

export function applyNodeDeletions(
  graph: Graph,
  plan: ReturnType<typeof planNodeDeletions>,
  actor: Pick<NodeDeletion, "by" | "run_id" | "submission_id">,
  endRun: (graph: Graph, worker: string, status: Run["status"], error?: string, runId?: string) => void,
) {
  const cancelled_runs: string[] = [],
    at = new Date().toISOString();
  if (plan.entries.length) {
    graph.node_lifecycle_version = 1;
    graph.project.pool_revision = (graph.project.pool_revision ?? 0) + 1;
  }
  for (const { node, input, kind } of plan.entries) {
    const cancellation = cancellationFor({ node, input, kind });
    if (kind === "steps" && "worker" in node) {
      if (cancellation) {
        const summary = node.summary;
        endRun(graph, cancellation.worker, "cancelled", "Step deleted by Decide", cancellation.run_id);
        node.summary = summary;
        cancelled_runs.push(cancellation.run_id);
      }
      node.worker = null;
      node.last_heartbeat_at = null;
    }
    if (kind === "findings" && "review_worker" in node) {
      if (cancellation) {
        endRun(graph, cancellation.worker, "cancelled", "Finding deleted by Decide", cancellation.run_id);
        cancelled_runs.push(cancellation.run_id);
      }
      node.review_worker = null;
      node.review_heartbeat = null;
    }
    node.deleted = { ...actor, at, reason: input.reason, root_id: input.id, cascade: input.cascade };
  }
  return {
    deleted: [...plan.ids].sort(),
    affected: plan.affected,
    cancelled_runs: [...new Set(cancelled_runs)].sort(),
  };
}
