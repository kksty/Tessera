import { useState } from "react";
import type { Graph } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";
import { coldNodes, isColdNode } from "../coldness.js";

/**
 * Cooling is memory management, not a judgment about exploration value.
 * 0 disables it entirely; manual pin/cool overrides the hot budget.
 */
export function CooldownControls({ graph, selectedId }: { graph: Graph; selectedId: string | null }) {
  const ws = useWorkspace();
  const [limit, setLimit] = useState(String(graph.project.hot_limit ?? 200));
  const nodes = [...graph.facts, ...graph.findings, ...graph.steps, ...graph.evidence] as {
    id: string; last_referenced_round?: number; last_read_round?: number; cooldown_override?: string;
  }[];
  const node = selectedId ? nodes.find(value => value.id === selectedId) : undefined;
  // Only Facts/Findings participate in hot/cold. Closed Steps and Evidence are history.
  const coolable = !!node && (
    graph.facts.some(value => value.id === node.id && value.id !== "origin" && value.kind !== "navigation")
    || graph.findings.some(value => value.id === node.id)
  );
  async function saveLimit() {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 0 || value > 1000) return;
    await ws.action(() => api(path(graph.project.id, "/cooldown"), { hot_limit: value }, "PUT"));
  }
  const setOverride = (override: "auto" | "pinned" | "cooled") =>
    ws.action(() => api(path(graph.project.id, "/cooldown"), { node_id: node!.id, override }, "PUT"));
  return <div className="cooldown-controls">
    <h3>冷热</h3>
    <p className="quiet">热节点上限默认 200 个 Fact/Finding；0 关闭（全部热）。只有 Fact/Finding 会冷（默认是超出上限的那些）；未关闭 Step 与其 Finding 永不冷却；已关闭 Step 与 Evidence 不是冷节点，不计入冷数。当前冷 {coldNodes(graph).length} 条。</p>
    <label>热节点上限
      <input aria-label="热节点上限" type="number" min={0} max={1000} step={1} value={limit}
        onChange={event => setLimit(event.target.value)} />
      <button type="button" disabled={ws.busy} onClick={() => void saveLimit()}>保存</button>
    </label>
    {node && <div className="cooldown-node">
      {coolable
        ? <span>选中 {node.id}：{isColdNode(graph, node) ? "冷" : "热"}{node.cooldown_override && node.cooldown_override !== "auto" ? `（${node.cooldown_override === "pinned" ? "人工保温" : "人工冷藏"}）` : ""}</span>
        : <span>选中 {node.id}：历史材料，不参与冷热。</span>}
      {coolable && <div>
        <button type="button" disabled={ws.busy} onClick={() => void setOverride("auto")}>自动</button>
        <button type="button" disabled={ws.busy} onClick={() => void setOverride("pinned")}>保温</button>
        <button type="button" disabled={ws.busy} onClick={() => void setOverride("cooled")}>冷藏</button>
      </div>}
    </div>}
  </div>;
}
