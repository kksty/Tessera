import { Route } from "lucide-react";
import { api, path } from "../api.js";
import { Badge } from "./ui.js";
import { CoverageTable } from "./CoverageTable.js";
import { HintControls } from "./HintControls.js";
import { scopeForNode } from "../graph-scope.js";
import { prettyText } from "../text.js";
import { fmt, stepState, useWorkspace } from "../workspace.js";
import { resolveGraphRelations } from "../../../../packages/protocol/src/graph-relations.js";
import { GraphReference } from "./NodeHistory.js";

/** 黑板节点的详情正文。详情栏与「双击节点」弹窗共用，避免两处字段漂移。 */
export function NodeDetail() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const id = ws.id!;
  const { node, displayStep, displayFact, displayFinding, sources } = ws;
  if (!node) return null;
  const provenance = displayFact ? resolveGraphRelations(ws.visible ?? graph).facts.get(displayFact.id) : undefined;
  return (
    <div className="detail-content">
      <button className="node-id" title="在黑板中高亮并定位" onClick={() => ws.setSelected(ws.selected)}>
        {ws.selected}
      </button>
      {ws.selected && (
        <button
          className="trace-chain"
          title={`查看 ${ws.selectedNodes.length > 1 ? ws.selectedNodes.join("、") : ws.selected} 的来路${displayStep ? "及直接产出" : ""}`}
          onClick={() => {
            const scope = scopeForNode(graph, ws.selected!);
            ws.setGraphScope(
              ws.selectedNodes.length > 1
                ? { ...scope, ids: [...ws.selectedNodes], label: `所选 ${ws.selectedNodes.length} 个节点的链路` }
                : scope,
            );
            ws.setFocus({ id: ws.selected!, seq: (ws.focus?.seq ?? 0) + 1 });
          }}
        >
          <Route size={13} />
          {ws.selectedNodes.length > 1 ? "查看所选链路" : "只看这条链路"}
        </button>
      )}
      <h2>
        {displayFinding?.title ||
          prettyText("description" in node ? node.description : "content" in node ? node.content : "")}
      </h2>
      {displayStep && (
        <>
          <Badge value={stepState(displayStep)} />
          {displayStep.property && (
            <>
              <label className="detail-label">验收属性</label>
              <p className="step-property">{prettyText(displayStep.property)}</p>
            </>
          )}
          {displayStep.method_hint && (
            <>
              <label className="detail-label">方法建议</label>
              <p className="quiet">{prettyText(displayStep.method_hint)}</p>
            </>
          )}
          {!displayStep.concluded_at && !displayStep.discarded && !displayStep.worker && ws.replayIndex === null && (
            <>
              <label className="detail-label">任务描述（下一轮 Decide 直接读取）</label>
              <textarea
                aria-label="编辑任务描述"
                defaultValue={displayStep.description}
                key={displayStep.id + (displayStep.version ?? 1)}
                rows={4}
                disabled={ws.busy || graph.project.status !== "active"}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== displayStep.description)
                    void ws.action(() =>
                      api(
                        path(id, `/fgs/steps/${displayStep.id}`),
                        {
                          description: value,
                          expected_version: displayStep.version ?? 1,
                        },
                        "PUT",
                      ),
                    );
                }}
              />
              {!!displayStep.edits?.length && (
                <p className="quiet">已被人改写 {displayStep.edits.length} 次，原文保留在事件流中。</p>
              )}
            </>
          )}
          <label className="detail-label">来源</label>
          <div className="source-links">
            {sources.map((s) => (
              <GraphReference key={s} nodeId={s} onSelect={() => ws.setSelected(s)} />
            ))}
          </div>
          <label className="detail-label">优先级</label>
          <input
            type="number"
            aria-label="Step 优先级"
            defaultValue={displayStep.priority}
            key={displayStep.id + displayStep.priority}
            disabled={ws.replayIndex !== null || graph.project.status !== "active"}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n !== displayStep.priority)
                void ws.action(() =>
                  api(
                    path(id, `/fgs/steps/${displayStep.id}`),
                    {
                      priority: n,
                    },
                    "PUT",
                  ),
                );
            }}
          />
          <label className="detail-label">执行结果</label>
          <p>{prettyText(displayStep.summary) || "尚未提交结果"}</p>
          {displayStep.to === "goal" && (
            <details className="detail-completion" open={!!displayStep.completion}>
              <summary>
                完成覆盖
                {displayStep.completion
                  ? `（记录 ${displayStep.completion.coverage.length} 项）`
                  : "（历史项目未记录）"}
              </summary>
              <CoverageTable graph={graph} entries={displayStep.completion?.coverage ?? []} />
              {!displayStep.completion && (
                <p className="quiet">该项目完成时尚未强制记录覆盖表；上表由当前图的事实提取，处置状态为「未登记」。</p>
              )}
            </details>
          )}
          <p className="quiet">
            领取 {displayStep.attempts} 次 · 创建于 {fmt(displayStep.created_at)}
          </p>
          {displayStep.retry_at && !displayStep.concluded_at && (
            <p className="quiet">
              {graph.project.status === "stopped"
                ? "项目已暂停，自动重试停止。"
                : `下次可领取：${fmt(displayStep.retry_at)}`}
            </p>
          )}
          {displayStep.worker && <p className="quiet mono">Worker {displayStep.worker}</p>}
          <label className="detail-label">产出事实</label>
          <div className="source-links">
            {displayStep.fact_ids.map((f) => (
              <button key={f} onClick={() => ws.setSelected(f)}>
                {f}
              </button>
            ))}
          </div>
          {displayStep.discarded && (
            <>
              <label className="detail-label">废弃理由</label>
              <p>{displayStep.discard_reason || "未记录理由"}</p>
            </>
          )}
          {!displayStep.concluded_at && ws.replayIndex === null && (
            <button className="danger subtle" disabled={ws.busy} onClick={() => ws.setModal("discard")}>
              废弃这个方向
            </button>
          )}
        </>
      )}
      {displayFact && (
        <>
          <label className="detail-label">观测状态</label>
          <p>{displayFact.status === "disputed" ? "审核已指出结论问题，待重新验证" : "观测事实"}</p>
          <label className="detail-label">生产来源</label>
          {provenance?.ambiguous && <p className="quiet">历史生产关系有歧义，以下为全部候选，所属 Run 未知。</p>}
          {provenance?.producers.length ? (
            provenance.producers.map((producer) => (
              <div key={producer.step_id}>
                <div className="source-links">
                  <GraphReference nodeId={producer.step_id} onSelect={() => ws.setSelected(producer.step_id)} />
                </div>
                <p className="quiet">
                  {producer.inferred ? "历史关联 · " : ""}Run：{producer.run_id || "未记录"}
                </p>
              </div>
            ))
          ) : (
            <p className="quiet">未记录生产 Step</p>
          )}
          {displayFact.created_at && <p className="quiet">观测于 {fmt(displayFact.created_at)}</p>}
          {ws.linkEvidence(displayFact.evidence_ids)}
        </>
      )}
      {displayFinding && (
        <>
          <Badge value={displayFinding.review_status} />
          <label className="detail-label">复现与证据</label>
          <p>{prettyText(displayFinding.evidence) || "尚未记录"}</p>
          {ws.linkEvidence(displayFinding.evidence_ids)}
          <label className="detail-label">来源事实</label>
          <div className="source-links">
            {displayFinding.from.map((f) => (
              <GraphReference key={f} nodeId={f} onSelect={() => ws.setSelected(f)} />
            ))}
          </div>
        </>
      )}
      {!displayStep && !displayFact && !displayFinding && "state" in node && <Badge value={node.state} />}
      {"content" in node && !displayStep && (
        <p className="quiet">人工提示。可在任务页搜索 {node.id}，查看描述中提及此提示的任务；文本提及不代表已回答。</p>
      )}
      {"content" in node && <HintControls hintId={node.id} />}
    </div>
  );
}
