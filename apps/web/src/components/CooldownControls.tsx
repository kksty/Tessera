import { useState } from "react";
import type { Graph } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";
import { coldNodes, coldState, isColdNode } from "../coldness.js";

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
  async function saveLimits() {
    const hot = Number(limit);
    const chars = Number(charLimit);
    if (!Number.isInteger(hot) || hot < 0 || hot > 1000) return;
    if (!Number.isInteger(chars) || chars < 0 || chars > 1_000_000) return;
    await ws.action(() => api(path(graph.project.id, "/cooldown"), { hot_limit: hot, hot_char_limit: chars }, "PUT"));
  }
  const setOverride = (override: "auto" | "pinned" | "cooled") =>
    ws.action(() => api(path(graph.project.id, "/cooldown"), { node_id: node!.id, override }, "PUT"));
  const used = view.disabled
    ? "冷却已关闭"
    : `热 ${view.hot.nodes}/${view.limit} · 冷 ${coldNodes(graph).length} · ${view.hot.chars}/${view.char_limit || "∞"} 字符${
        view.hot.over_budget ? " · 必显已超预算" : ""
      }`;
  return (
    <div className="cooldown-controls">
      <h3>入口预算（冷热）</h3>
      <p className="quiet">
        入口只保留热节点：Facts/Findings
        数量与字符两个预算，任一到达上限即冷却其余节点；冷池不设上限，可用检索/读取回热。新项目默认 80 个 / 64,000
        字符，旧项目沿用原值（缺省按 200 个）。当前：{used}。
      </p>
      <label>
        热节点上限
        <input
          aria-label="热节点上限"
          type="number"
          min={0}
          max={1000}
          step={1}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </label>
      <label>
        入口字符预算
        <input
          aria-label="入口字符预算"
          type="number"
          min={0}
          max={1000000}
          step={1000}
          value={charLimit}
          onChange={(event) => setCharLimit(event.target.value)}
        />
      </label>
      <button type="button" disabled={ws.busy} onClick={() => void saveLimits()}>
        保存预算
      </button>
      <button
        type="button"
        disabled={ws.busy}
        onClick={() => {
          setLimit("80");
          setCharLimit("64000");
        }}
      >
        应用推荐值（80 / 64k）
      </button>
      {node && (
        <div className="cooldown-node">
          {coolable ? (
            <span>
              选中 {node.id}：{isColdNode(graph, node) ? "冷" : "热"}
              {node.cooldown_override && node.cooldown_override !== "auto"
                ? `（${node.cooldown_override === "pinned" ? "人工保温" : "人工冷藏"}）`
                : ""}
            </span>
          ) : (
            <span>选中 {node.id}：历史材料，不参与冷热。</span>
          )}
          {coolable && (
            <div>
              <button type="button" disabled={ws.busy} onClick={() => void setOverride("auto")}>
                自动
              </button>
              <button type="button" disabled={ws.busy} onClick={() => void setOverride("pinned")}>
                保温
              </button>
              <button type="button" disabled={ws.busy} onClick={() => void setOverride("cooled")}>
                冷藏
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
