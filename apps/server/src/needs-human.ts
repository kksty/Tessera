import type { Store } from "../../../packages/core/src/store.js";
import type { PendingItem } from "./notifications.js";

/**
 * Snapshot everything that currently needs a human operator: interrupted Runs
 * awaiting a retry decision, assets awaiting approval, and project errors.
 * Pure read-only projection over the store; the caller decides whether to notify.
 */
export function collectPendingItems(store: Store): PendingItem[] {
  const items: PendingItem[] = [];
  for (const project of store.list()) {
    const graph = store.get(project.id);
    const blockedRuns = store
      .runs(project.id, 200)
      .filter(
        (run) =>
          run.status === "needs_attention" &&
          !run.resolved_at &&
          !!run.node_id &&
          graph.steps.some((s) => s.id === run.node_id && !s.deleted && !s.concluded_at && !s.discarded),
      );
    if (blockedRuns.length)
      items.push({
        key: `${project.id}:retry`,
        kind: "retry",
        line: `${project.title}：${blockedRuns.length} 次运行待人工重试`,
        at: blockedRuns
          .map((run) => run.finished_at || run.heartbeat_at)
          .sort()
          .at(-1),
      });
    if (project.pending_asset_count > 0)
      items.push({
        key: `${project.id}:assets`,
        kind: "assets",
        line: `${project.title}：${project.pending_asset_count} 个资产等待人工批准`,
        at: graph.assets
          .filter((asset) => asset.approval === "pending")
          .map((asset) => asset.created_at)
          .sort()
          .at(-1),
      });
    if (project.last_error)
      items.push({
        key: `${project.id}:error`,
        kind: "error",
        line: `${project.title}：项目错误 — ${String(project.last_error).replace(/\s+/g, " ").slice(0, 120)}`,
      });
  }
  return items;
}
