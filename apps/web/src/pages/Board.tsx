import { useEffect, useState } from "react";
import {
  GitBranch,
  History,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { api, path } from "../api.js";
import { Blackboard } from "../Blackboard.js";
import { WorkbenchTools, QuickSidebar, type QuickTab } from "../WorkbenchTools.js";
import { Drawer, Modal } from "../components/ui.js";
import { NodeDetail } from "../components/NodeDetail.js";
import { DeletedNodeHistory } from "../components/NodeHistory.js";
import { CooldownControls } from "../components/CooldownControls.js";
import { localPrefs } from "../layouts.js";
import { changedIds, replayBoard } from "../replay.js";
import { eventTargets } from "../graph-scope.js";
import { locateRecord, readableError, useWorkspace } from "../workspace.js";
import { boardTimelineText } from "../board-timeline.js";

export function BoardPage() {
  const [manualOpen, setManualOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(() => localStorage.getItem("tessera.boardPanelHidden") === "true");
  const [quickTab, setQuickTab] = useState<QuickTab | null>(null);
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
    <div
      className={`board-layout${panelHidden ? " panel-hidden" : ""}`}
      style={{ "--detail-panel-width": ws.panelWidth + "px" } as React.CSSProperties}
    >
      <section className="board-area">
        <div className="board-top">
          <span className="quiet">
            {ws.graphScope
              ? "链路视图"
              : `${visible.facts.filter((f) => f.graph_id === ws.graphId).length} 条事实 · ${visible.steps.filter((s) => s.graph_id === ws.graphId).length} 项任务`}
          </span>
          {graph.project.status === "stopped" && <span className="quiet">已暂停 · 当前无执行中任务</span>}
          {panelHidden && <span className="board-hint">双击节点查看详情</span>}
          <span className="spacer" />
          <DeletedNodeHistory />
          <button onClick={() => setManualOpen(true)} title="手工声明任务、接管执行与提交结果">
            <SlidersHorizontal size={14} />
            <span>人工干预</span>
          </button>
          <button
            aria-label={panelHidden ? "展开黑板详情" : "收起黑板详情"}
            aria-expanded={!panelHidden}
            onClick={() => {
              const next = !panelHidden;
              setPanelHidden(next);
              localStorage.setItem("tessera.boardPanelHidden", String(next));
            }}
          >
            {panelHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
            <span>{panelHidden ? "展开详情" : "收起详情"}</span>
          </button>
        </div>
        {manualOpen && (
          <Drawer label="人工干预" title="人工干预" width={500} onClose={() => setManualOpen(false)}>
            <p className="manual-help">
              日常探索由模型推进。手动操作会写入工作图并留下事件记录，执行权仍由调度器管理；先选中任务或事实，再选择动作。
            </p>
            <WorkbenchTools
              graph={graph}
              selectedFacts={ws.selectedFacts}
              selectedId={ws.selected}
              replaying={ws.replayIndex !== null}
              afterChange={ws.action}
              onRemoveFact={(id) => ws.selectNode(id, true)}
            />
            <CooldownControls graph={graph} selectedId={ws.selected} />
          </Drawer>
        )}
        <Blackboard
          graph={visible}
          graphId={ws.graphId}
          selected={ws.selected}
          selectedFacts={ws.selectedFacts}
          selectedNodes={ws.selectedNodes}
          focus={ws.focus}
          scope={ws.graphScope}
          onClearScope={ws.clearGraphScope}
          onSelect={(nodeId, additive) => {
            setQuickTab(null);
            ws.selectNode(nodeId, additive);
          }}
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
            <span className="replay-position">
              回放 {ws.replayIndex + 1}/{ws.boardEvents.length}
            </span>
            <button
              aria-label={ws.playing ? "暂停回放" : "播放回放"}
              onClick={() => {
                if (!ws.playing && ws.replayIndex! >= ws.boardEvents.length - 1) ws.setReplayIndex(0);
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
            <select aria-label="回放速度" value={ws.speed} onChange={(e) => ws.setSpeed(Number(e.target.value))}>
              <option value={2200}>0.5×</option>
              <option value={1100}>1×</option>
              <option value={550}>2×</option>
            </select>
            <input
              aria-label="回放位置"
              type="range"
              min={0}
              max={Math.max(0, ws.boardEvents.length - 1)}
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
        className={`detail-panel${quickTab ? " quick-open" : ""}`}
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
            const next = Math.max(220, Math.min(600, ws.panelWidth + (e.key === "ArrowLeft" ? 20 : -20)));
            ws.setPanelWidth(next);
            localStorage.setItem("tessera.sidePanelWidth", String(next));
          }}
        />
        <QuickSidebar
          graph={visible}
          selectedId={ws.selected}
          tab={quickTab}
          onTabChange={setQuickTab}
          onSelect={(nid) => {
            locateRecord(ws, nid);
          }}
        />
        {!quickTab && (
          <>
            <div className="detail-tabs">
              <button className={ws.historyTab === "detail" ? "active" : ""} onClick={() => ws.setHistoryTab("detail")}>
                详情
              </button>
              <button
                className={ws.historyTab === "history" ? "active" : ""}
                onClick={() => ws.setHistoryTab("history")}
              >
                黑板时间线 <span>{ws.boardEvents.length}</span>
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
                    <div className="last-error">最近执行问题：{readableError(graph.project.last_error)}</div>
                  )}
                </div>
              )
            ) : (
              <Timeline />
            )}
          </>
        )}
      </aside>
      {inspectOpen && node && (
        <Modal
          label="节点详情"
          title={
            <>
              <span className="node-modal-kicker">节点详情</span>
              <span className="mono">{ws.selected}</span>
            </>
          }
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
      <input
        className="hint-priority"
        aria-label="新提示优先级"
        title="优先级：数字越大越先"
        type="number"
        value={priority}
        onChange={(e) => setPriority(Number(e.target.value))}
      />
      <button className="primary" disabled={ws.busy || !ws.hint.trim()}>
        添加 Hint
      </button>
    </form>
  );
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "今天";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "昨天";
  const prefix = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()} 年 `;
  return `${prefix}${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${date.toLocaleDateString("zh-CN", { weekday: "short" })}`;
}

function localClock(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function Timeline() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const items = ws.boardEvents.map((event, index) => ({ event, index, ...boardTimelineText(event, graph) })).reverse();
  const groups: { key: string; label: string; items: typeof items }[] = [];
  for (const item of items) {
    const key = localDayKey(new Date(item.event.created_at));
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: localDayLabel(item.event.created_at), items: [item] });
  }
  return (
    <div className="board-timeline">
      <div className="board-timeline-toolbar">
        <button
          className="board-timeline-replay"
          onClick={() => {
            ws.setReplayIndex(0);
            ws.setPlaying(true);
          }}
        >
          <Play size={12} />
          回放全过程
        </button>
        <span className="board-timeline-total">{ws.boardEvents.length} 次图变化</span>
      </div>
      {groups.map((group) => (
        <section className="board-timeline-group" key={group.key} aria-label={group.label}>
          <h3 className="board-timeline-date">
            {group.label}
            <span>{group.items.length} 次</span>
          </h3>
          <ol className="board-timeline-list">
            {group.items.map(({ event, index, title, detail }) => (
              <li key={event.seq}>
                <button
                  className="board-timeline-event"
                  aria-current={ws.replayIndex === index ? "step" : undefined}
                  title={`第 ${event.revision} 次图更新`}
                  onClick={() => {
                    ws.setReplayIndex(index);
                    const snapshot = replayBoard(ws.events, ws.boardEvents, index) || graph;
                    const target = eventTargets(snapshot, event)[0] || null;
                    // 回放一条事件只「定位到它改动的节点」；画布保持总视图，不切链路。
                    ws.setSelected(target);
                    if (target)
                      ws.setFocus({
                        id: target,
                        seq: (ws.focus?.seq ?? 0) + 1,
                      });
                  }}
                >
                  <span className="board-timeline-dot" aria-hidden="true" />
                  <span className="board-timeline-body">
                    <span className="board-timeline-title">{title}</span>
                    {detail && <span className="board-timeline-detail">{detail}</span>}
                  </span>
                  <time className="board-timeline-time" dateTime={event.created_at}>
                    {localClock(event.created_at)}
                  </time>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {!groups.length && <p className="board-timeline-empty">还没有会改变画面的历史。</p>}
    </div>
  );
}
