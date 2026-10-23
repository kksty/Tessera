import { useEffect, useState } from "react";
import type { MemoryRecordPage } from "../../../../packages/core/src/memory.js";
import { api, path } from "../api.js";
import { fmt, useWorkspace } from "../workspace.js";
import { Drawer } from "./ui.js";

export function NodeHistoryDrawer({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const ws = useWorkspace(), projectId = ws.id!;
  const [page, setPage] = useState<MemoryRecordPage | null>(null), [error, setError] = useState("");
  const [offset, setOffset] = useState(0), [hash, setHash] = useState<string>();
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ offset: String(offset), limit: "4000", ...(offset && hash ? { expected_hash: hash } : {}) });
    setPage(null); setError("");
    void api<MemoryRecordPage>(path(projectId, `/fgs/history/${encodeURIComponent(nodeId)}?${query}`))
      .then(value => { if (active) { setPage(value); if (!offset) setHash(value.record_hash); } })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [projectId, nodeId, offset]);
  return <Drawer label="节点历史" title={`节点历史 · ${nodeId}`} onClose={onClose}>
    <div className="detail-content">
      {error && <p className="banner danger">{error}</p>}
      {page?.error && <p className="banner danger">{page.error}</p>}
      {page?.deletion && <>
        <p>已删除 · {fmt(page.deletion.at)} · {page.deletion.by}</p>
        <p>{page.deletion.reason}</p>
        <p className="quiet">Decide Run：{page.deletion.run_id || "未记录"}<br />提交键：{page.deletion.submission_id}</p>
      </>}
      <p className="quiet">此处是保留的原始历史，节点不会恢复到当前工作图。</p>
      {page?.content && <pre>{page.content}</pre>}
      {!page && !error && <p>正在读取…</p>}
      <div className="report-actions">
        <button className="button small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 4000))}>上一页</button>
        <span className="quiet">{offset} / {page?.total_chars ?? "—"} 字符</span>
        <button className="button small" disabled={page?.next_offset == null} onClick={() => setOffset(page!.next_offset!)}>下一页</button>
      </div>
    </div>
  </Drawer>;
}

export function GraphReference({ nodeId, onSelect, className }: { nodeId: string; onSelect(): void; className?: string }) {
  const ws = useWorkspace(), [history, setHistory] = useState(false);
  const removed = (ws.visible ?? ws.graph)?.deleted_nodes?.some(ref => ref.id === nodeId);
  return <>
    <button type="button" className={className} title={removed ? "来源节点已删除，查看保留的原始历史" : undefined}
      onClick={() => removed ? setHistory(true) : onSelect()}>{nodeId}{removed ? " · 已删除" : ""}</button>
    {history && <NodeHistoryDrawer nodeId={nodeId} onClose={() => setHistory(false)} />}
  </>;
}

export function DeletedNodeHistory() {
  const ws = useWorkspace(), [open, setOpen] = useState(false), [selected, setSelected] = useState<string>();
  const refs = ws.graph?.deleted_nodes ?? [];
  if (!refs.length) return null;
  return <>
    <button onClick={() => setOpen(true)}>删除历史 {refs.length}</button>
    {open && <Drawer label="删除历史" title="已删除的工作图节点" onClose={() => setOpen(false)}>
      <p className="quiet">仅在此历史入口读取原文，当前图、调度和交付不包含这些节点。</p>
      {refs.map(ref => <div className="report-row" key={ref.id}>
        <span>{ref.id} · {fmt(ref.deleted_at)}</span>
        <button className="button small" onClick={() => { setOpen(false); setSelected(ref.id); }}>读取历史 {ref.id}</button>
      </div>)}
    </Drawer>}
    {selected && <NodeHistoryDrawer key={selected} nodeId={selected} onClose={() => setSelected(undefined)} />}
  </>;
}
