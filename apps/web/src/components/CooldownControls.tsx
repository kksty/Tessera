import { useState } from "react";
import type { Graph } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";
import { coldNodes, coldState, isColdNode } from "../coldness.js";
import { Segmented } from "./ui.js";

type Override = "auto" | "pinned" | "cooled";

/**
 * Cooling is memory management, not a judgment about exploration value.
 * Both budgets are per entry: node count AND characters. 0 disables a budget;
 * `hot_limit=0` disables cooling entirely; manual pin/cool overrides both.
 */
export function CooldownControls({ graph, selectedId }: { graph: Graph; selectedId: string | null }) {
  const ws = useWorkspace();
  const [limit, setLimit] = useState(String(graph.project.hot_limit ?? 200));
  const [charLimit, setCharLimit] = useState(String(graph.project.hot_char_limit ?? 64000));
  const view = coldState(graph);
  const nodes = [...graph.facts, ...graph.findings, ...graph.steps, ...graph.evidence] as {
    id: string;
    last_referenced_round?: number;
    last_read_round?: number;
    cooldown_override?: string;
  }[];
  const node = selectedId ? nodes.find((value) => value.id === selectedId) : undefined;
  // Only Facts/Findings participate in hot/cold. Closed Steps and Evidence are history.
  const coolable =
    !!node &&
    (graph.facts.some((value) => value.id === node.id && value.id !== "origin" && value.kind !== "navigation") ||
      graph.findings.some((value) => value.id === node.id));
  const cold = coldNodes(graph).length;
  const override: Override =
    node?.cooldown_override === "pinned" || node?.cooldown_override === "cooled" ? node.cooldown_override : "auto";
  async function saveLimits() {
    const hot = Number(limit);
    const chars = Number(charLimit);
    if (!Number.isInteger(hot) || hot < 0 || hot > 1000) return;
    if (!Number.isInteger(chars) || chars < 0 || chars > 1_000_000) return;
    await ws.action(() => api(path(graph.project.id, "/cooldown"), { hot_limit: hot, hot_char_limit: chars }, "PUT"));
  }
  const setOverride = (next: Override) =>
    ws.action(() => api(path(graph.project.id, "/cooldown"), { node_id: node!.id, override: next }, "PUT"));
  const hotLimit = view.disabled ? "关闭" : `${view.hot.nodes}/${view.limit}`;
  const charBudget = view.char_limit ? view.char_limit.toLocaleString("zh-CN") : "不限";
  return (
    <section className="manual-section cooldown-controls">
      <h3>
        入口预算 <span className="manual-section-note">冷热</span>
      </h3>
      <p className="cooldown-summary" data-over={view.hot.over_budget || undefined}>
        <span>
          热 <strong>{hotLimit}</strong>
        </span>
        <span>冷 {cold}</span>
        <span>
          <strong>{view.hot.chars.toLocaleString("zh-CN")}</strong> / {charBudget} 字符
        </span>
      </p>
      {view.hot.over_budget && <p className="cooldown-alert">必显节点已超出预算，建议关闭或合并任务。</p>}
      <details className="cooldown-help">
        <summary>预算如何生效</summary>
        <p>
          入口只保留热节点（Facts / Findings）：数量或字符任一到达预算，其余节点转冷。冷池不设上限，可按需检索回热。
          新项目默认 80 个 / 64,000 字符；旧项目沿用原值。
        </p>
        <p>热节点上限为 0 会关闭冷却；字符预算为 0 表示不限制字符。</p>
      </details>
      <div className="cooldown-fields">
        <label className="cooldown-field">
          <span>热节点上限</span>
          <input
            aria-label="热节点上限"
            type="number"
            min={0}
            max={1000}
            step={1}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
          <small>0 关闭冷却</small>
        </label>
        <label className="cooldown-field">
          <span>入口字符预算</span>
          <input
            aria-label="入口字符预算"
            type="number"
            min={0}
            max={1000000}
            step={1000}
            value={charLimit}
            onChange={(event) => setCharLimit(event.target.value)}
          />
          <small>0 不限制字符</small>
        </label>
      </div>
      <div className="cooldown-actions">
        <button type="button" className="button small primary" disabled={ws.busy} onClick={() => void saveLimits()}>
          保存预算
        </button>
        <button
          type="button"
          className="button small ghost"
          disabled={ws.busy}
          onClick={() => {
            setLimit("80");
            setCharLimit("64000");
          }}
        >
          用推荐值 80 / 64k
        </button>
      </div>
      {node && (
        <div className="cooldown-node">
          <div className="cooldown-node-head">
            <span>选中节点</span>
            <code>{node.id}</code>
            {coolable && (
              <span className="cooldown-state" data-cold={isColdNode(graph, node) || undefined}>
                {isColdNode(graph, node) ? "冷" : "热"}
                {override !== "auto" ? ` · ${override === "pinned" ? "人工保温" : "人工冷藏"}` : ""}
              </span>
            )}
          </div>
          {coolable ? (
            <Segmented<Override>
              value={override}
              options={[
                ["auto", "自动"],
                ["pinned", "保温"],
                ["cooled", "冷藏"],
              ]}
              onChange={(value) => void setOverride(value)}
              ariaLabel="选中节点的冷热策略"
              size="sm"
            />
          ) : (
            <p className="quiet">历史材料，不参与冷热。</p>
          )}
        </div>
      )}
    </section>
  );
}
