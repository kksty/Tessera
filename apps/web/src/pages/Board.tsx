import { useEffect, useState } from "react";
import {
  GitBranch,
  History,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { api, path } from "../api.js";
import { Blackboard } from "../Blackboard.js";
import { WorkbenchTools, QuickSidebar } from "../WorkbenchTools.js";
import { Drawer, Modal } from "../components/ui.js";
import { NodeDetail } from "../components/NodeDetail.js";
import { DeletedNodeHistory } from "../components/NodeHistory.js";
import { CooldownControls } from "../components/CooldownControls.js";
import { localPrefs } from "../layouts.js";
import { changedIds, replay } from "../replay.js";
import { eventTargets } from "../graph-scope.js";
import { fmt, locateRecord, readableError, useWorkspace } from "../workspace.js";

export function BoardPage() {
  const [manualOpen, setManualOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(() => localStorage.getItem("tessera.boardPanelHidden") === "true");
  const ws = useWorkspace();
  useEffect(() => {
    if (!ws.node) setInspectOpen(false);
  }, [ws.node]);
  useEffect(() => {
    if (!inspectOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspectOpen]);
  const graph = ws.graph!;
  const visible = ws.visible!;
  const id = ws.id!;
  const { node } = ws;

  return (
    <div className={`board-layout${panelHidden ? " panel-hidden" : ""}`} style={{ "--detail-panel-width": ws.panelWidth + "px" } as React.CSSProperties}>
      <section className="board-area">
        <div className="board-top">
          <span className="quiet">
            {ws.graphScope ? "链路视图" : `${visible.facts.filter((f) => f.graph_id === ws.graphId).length} 条事实 · ${visible.steps.filter((s) => s.graph_id === ws.graphId).length} 项任务`}
          </span>
          {graph.project.status === "stopped" && <span className="quiet">已暂停 · 当前无执行中任务</span>}
          {panelHidden && <span className="board-hint">双击节点查看详情</span>}
          <span className="spacer" />
          <DeletedNodeHistory />
          <button onClick={() => setManualOpen(true)} title="手工声明任务、接管执行与提交结果">
            <SlidersHorizontal size={14} /><span>人工干预</span>
          </button>
          <button aria-label={panelHidden ? "展开黑板详情" : "收起黑板详情"} aria-expanded={!panelHidden} onClick={() => { const next = !panelHidden; setPanelHidden(next); localStorage.setItem("tessera.boardPanelHidden", String(next)); }}>
            {panelHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}<span>{panelHidden ? "展开详情" : "收起详情"}</span>
          </button>
        </div>
        {manualOpen && <Drawer label="人工干预" title="人工干预" onClose={() => setManualOpen(false)}>
          <p className="manual-help">日常探索由模型推进。需要手工接管时，在黑板上选择任务或事实，再使用以下操作。</p>
          <WorkbenchTools graph={graph} selectedFacts={ws.selectedFacts} selectedId={ws.selected}
            replaying={ws.replayIndex !== null} afterChange={ws.action} onRemoveFact={id => ws.selectNode(id, true)} />
          <CooldownControls graph={graph} selectedId={ws.selected} />
        </Drawer>}
        <Blackboard
          graph={visible}
          graphId={ws.graphId}
          selected={ws.selected}
          selectedFacts={ws.selectedFacts}
          selectedNodes={ws.selectedNodes}
          focus={ws.focus}
          scope={ws.graphScope}
          onClearScope={ws.clearGraphScope}
          onSelect={ws.selectNode}
          onInspect={(nodeId) => {
            if (!panelHidden) return;
            // 双击只打开详情弹窗，不改变视角；画布保持用户当前的缩放与平移。
            ws.selectNode(nodeId);
            setInspectOpen(true);
          }}
          deciding={!!graph.project.reason && graph.project.status === "active" && ws.replayIndex === null}
          replaying={ws.replayIndex !== null}
        />
        {ws.replayIndex !== null && (
          <div className="replay-bar">
            <History size={15} />
            <span className="replay-position">回放 {ws.replayIndex + 1}/{ws.events.length}</span>
            <button
              aria-label={ws.playing ? "暂停回放" : "播放回放"}
              onClick={() => {
                if (!ws.playing && ws.replayIndex! >= ws.events.length - 1) ws.setReplayIndex(0);
                ws.setPlaying(!ws.playing);
              }}
            >
              {ws.playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button
              aria-label="重启回放"
              onClick={() => {
                ws.setReplayIndex(0);
                ws.setPlaying(true);
              }}
            >
              <RotateCcw size={13} />
            </button>
            <select
              aria-label="回放速度"
              value={ws.speed}
              onChange={(e) => ws.setSpeed(Number(e.target.value))}
            >
              <option value={2200}>0.5×</option>
              <option value={1100}>1×</option>
              <option value={550}>2×</option>
            </select>
            <input
              aria-label="回放位置"
              type="range"
              min={0}
              max={Math.max(0, ws.events.length - 1)}
              value={ws.replayIndex}
              onChange={(e) => ws.setReplayIndex(Number(e.target.value))}
            />
            <button
              className="primary"
              title="退出回放，回到当前状态"
              onClick={() => {
                ws.setReplayIndex(null);
                ws.clearGraphScope();
              }}
            >
              回到实时
            </button>
          </div>
        )}
        <HintBar />
      </section>

      <aside
        className="detail-panel"
        hidden={panelHidden}
        style={{ "--detail-panel-width": ws.panelWidth + "px" } as React.CSSProperties}
      >
        <div
          className="panel-resizer"
          role="separator"
          aria-label="调整详情面板宽度"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={ws.resizePanel}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            const next = Math.max(
              220,
              Math.min(600, ws.panelWidth + (e.key === "ArrowLeft" ? 20 : -20)),
            );
            ws.setPanelWidth(next);
            localStorage.setItem("tessera.sidePanelWidth", String(next));
          }}
        />
        <QuickSidebar
          graph={visible}
          selectedId={ws.selected}
          onSelect={(nid) => {
            locateRecord(ws, nid);
          }}
        />
        <div className="detail-tabs">
          <button
            className={ws.historyTab === "detail" ? "active" : ""}
            onClick={() => ws.setHistoryTab("detail")}
          >
            详情
          </button>
          <button
            className={ws.historyTab === "history" ? "active" : ""}
            onClick={() => ws.setHistoryTab("history")}
          >
            黑板时间线 <span>{ws.events.length}</span>
          </button>
        </div>

        {ws.historyTab === "detail" ? (
          node ? (
            <NodeDetail />
          ) : (
            <div className="detail-empty">
              <GitBranch size={30} />
              <h3>每一步，都有依据</h3>
              <p>点击节点查看事实、目标、探索结果和证据。</p>
              <div className="root-goal">
                <small>当前目标</small>
                <p>{graph.goals.find((g) => g.id === "goal")?.description}</p>
              </div>
              {graph.project.last_error && (
                <div className="last-error">
                  最近执行问题：{readableError(graph.project.last_error)}
                </div>
              )}
            </div>
          )
        ) : (
          <Timeline />
        )}
      </aside>
      {inspectOpen && node && (
        <Modal
          label="节点详情"
          title={<><span className="node-modal-kicker">节点详情</span><span className="mono">{ws.selected}</span></>}
          onClose={() => setInspectOpen(false)}
          className="node-detail-modal"
        >
          <div
            className="node-detail-body"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest(".trace-chain, .evidence-link, .danger")) setInspectOpen(false);
            }}
          >
            <NodeDetail />
          </div>
        </Modal>
      )}
    </div>
  );
}

function HintBar() {
  const ws = useWorkspace();
  const [priority, setPriority] = useState(0);
  return (
    <form
      className="hint-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ws.hint.trim()) return;
        void ws
          .action(() =>
            api(path(ws.id!, "/hints"), {
              content: ws.hint,
              creator: localPrefs().actor_name,
              priority,
            }),
          )
          .then((ok) => {
            if (ok) ws.setHint("");
          });
      }}
    >
      <MessageSquare size={17} />
      <input
        aria-label="补充 Hint"
        placeholder="补充 Hint：账号信息、观察、优先方向…"
        value={ws.hint}
        onChange={(e) => ws.setHint(e.target.value)}
      />
      <input className="hint-priority" aria-label="新提示优先级" title="优先级：数字越大越先" type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} />
      <button className="primary" disabled={ws.busy || !ws.hint.trim()}>
        添加 Hint
      </button>
    </form>
  );
}

function Timeline() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  return (
    <div className="timeline">
      <button
        className="timeline-replay"
        onClick={() => {
          ws.setReplayIndex(0);
          ws.setPlaying(true);
        }}
      >
        <Play size={13} />
        回放黑板历史
      </button>
      {ws.events
        .slice()
        .reverse()
        .map((e) => (
          <button
            className="timeline-event"
            key={e.seq}
            onClick={() => {
              const index = ws.events.indexOf(e);
              ws.setReplayIndex(index);
              const snapshot = replay(ws.events, index) || graph;
              const target = eventTargets(snapshot, e)[0] || null;
              // 回放一条事件只「定位到它改动的节点」；画布保持总视图，不切链路。
              ws.setSelected(target);
              if (target)
                ws.setFocus({
                  id: target,
                  seq: (ws.focus?.seq ?? 0) + 1,
                });
            }}
          >
            <span className="timeline-event-dot" />
            <small>{fmt(e.created_at)}</small>
            <strong>{e.kind}</strong>
            <span>图版本 {e.revision}</span>
          </button>
        ))}
    </div>
  );
}
