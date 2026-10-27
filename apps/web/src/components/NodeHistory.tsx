import { useEffect, useState, type ReactNode } from "react";
import type { DeletedNodeRef } from "../../../../packages/protocol/src/index.js";
import type { MemoryRecordPage } from "../../../../packages/core/src/memory.js";
import { api, path } from "../api.js";
import { fmt, fmtDay, fmtTime, severityLabels, statusLabels } from "../format.js";
import { localPrefs } from "../layouts.js";
import { useWorkspace } from "../workspace.js";
import { nodeReference } from "../node-reference.js";
import { prettyText } from "../text.js";
import { Drawer } from "./ui.js";
import { Archive, ChevronRight } from "lucide-react";

const kindLabels: Record<string, string> = {
  facts: "事实",
  steps: "任务",
  findings: "发现",
  goals: "目标",
};

function restoreFinding(projectId: string, findingId: string) {
  return api(path(projectId, `/findings/${encodeURIComponent(findingId)}/restore`), {
    creator: localPrefs().actor_name,
  });
}

function parseRecord(page: MemoryRecordPage | null) {
  if (!page?.content || page.offset !== 0 || page.next_offset != null) return null;
  try {
    const value: unknown = JSON.parse(page.content);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

function stepStateText(record: Record<string, unknown>) {
  if (record.discarded) return "已废弃";
  if (record.concluded_at) return "已关闭";
  if (record.executed_at) return "已执行";
  if (record.worker) return "执行中";
  return "待领取";
}

function HistorySummary({ kind, record }: { kind: string; record: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const fields: { label: string; value: ReactNode }[] = [];
  const add = (label: string, value: ReactNode) => {
    if (value !== null && value !== undefined && value !== "") fields.push({ label, value });
  };
  let title = "";
  let body = "";
  if (kind === "facts") {
    title = text(record.conclusion) || text(record.description);
    body = text(record.description) === title ? "" : text(record.description);
    add("状态", statusLabels[text(record.status)] || text(record.status));
    add("来源任务", text(record.step_id));
    add("资产", text(record.asset_id));
    add("证据", `${count(record.evidence_ids)} 项`);
    add("观测于", fmt(text(record.created_at)));
  } else if (kind === "steps") {
    title = text(record.description);
    body = text(record.summary);
    add("状态", stepStateText(record));
    add("测试域", text(record.test_domain) || text(record.focus));
    add("产出事实", `${count(record.fact_ids)} 条`);
    add("领取次数", String(record.attempts ?? 0));
    add("创建于", fmt(text(record.created_at)));
  } else if (kind === "findings") {
    title = text(record.title);
    body = text(record.description) || text(record.evidence);
    add("严重性", severityLabels[text(record.severity)] || text(record.severity) || "未定级");
    add("审核", statusLabels[text(record.review_status)] || text(record.review_status));
    add("版本", `v${String(record.version ?? 1)}`);
    add("证据", `${count(record.evidence_ids)} 项`);
    add("提交于", fmt(text(record.created_at)));
  } else {
    title = text(record.description);
    body = text(record.content);
    add("状态", statusLabels[text(record.state)] || text(record.state));
  }
  if (!title && !body && !fields.length) return null;
  const longText = title.length > 240 || body.length > 800;
  return (
    <div className="history-record">
      {title && (
        <p className="history-record-title" data-expanded={expanded || undefined}>
          {prettyText(title)}
        </p>
      )}
      {!!fields.length && (
        <dl className="history-fields">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && (
        <p className="history-record-text" data-expanded={expanded || undefined}>
          {prettyText(body)}
        </p>
      )}
      {longText && (
        <div className="history-long">
          <button type="button" className="button ghost small" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起全文" : "展开全文"}
          </button>
          {!expanded && <span>长文仅显示摘要；原始 JSON 保留完整记录。</span>}
        </div>
      )}
    </div>
  );
}

export function NodeHistoryDrawer({ nodeId, onClose }: { nodeId: string; onClose(): void }) {
  const ws = useWorkspace(),
    projectId = ws.id!;
  const [page, setPage] = useState<MemoryRecordPage | null>(null),
    [error, setError] = useState("");
  const [offset, setOffset] = useState(0),
    [hash, setHash] = useState<string>();
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      offset: String(offset),
      limit: "4000",
      ...(offset && hash ? { expected_hash: hash } : {}),
    });
    setPage(null);
    setError("");
    void api<MemoryRecordPage>(path(projectId, `/fgs/history/${encodeURIComponent(nodeId)}?${query}`))
      .then((value) => {
        if (active) {
          setPage(value);
          if (!offset) setHash(value.record_hash);
        }
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [projectId, nodeId, offset]);
  const record = parseRecord(page);
  const kind = kindLabels[page?.kind || ""] || "";
  const canRestore = page?.kind === "findings" && !!page.deletion;
  return (
    <Drawer label="节点历史" title={`节点历史 · ${nodeId}`} width={520} onClose={onClose}>
      <div className="detail-content history-detail">
        {error && <p className="banner danger">{error}</p>}
        {page?.error && <p className="banner danger">{page.error}</p>}

        {page?.deletion && (
          <div className="history-deletion">
            <div className="history-deletion-head">
              <span className="status-pill" data-tone="danger" data-dot>
                <i aria-hidden="true" />
                已删除
              </span>
              <span>{kind}</span>
              <span className="mono">{nodeId}</span>
              <time dateTime={page.deletion.at}>{fmt(page.deletion.at)}</time>
            </div>
            {page.deletion.reason && <p className="history-reason">{page.deletion.reason}</p>}
            <p className="history-audit mono">
              Run：{page.deletion.run_id || "未记录"} · 提交键：{page.deletion.submission_id}
            </p>
            {page.deletion.by && <p className="history-audit">删除者：{page.deletion.by}</p>}
          </div>
        )}

        {record ? (
          <HistorySummary kind={page?.kind || ""} record={record} />
        ) : page?.content ? (
          <p className="quiet">原文较长，按页读取；完整内容见下方原始 JSON。</p>
        ) : (
          !error && <p className="quiet">正在读取…</p>
        )}

        {page?.kind === "findings" && page.deletion && (
          <p className="quiet">恢复只清除删除标记：同一 ID、版本、证据、审核和报告快照都保留。</p>
        )}

        {page?.content && (
          <details className="history-raw" open={!record || offset > 0}>
            <summary>原始 JSON · {page.total_chars?.toLocaleString("zh-CN") ?? "—"} 字符</summary>
            <pre>{page.content}</pre>
          </details>
        )}

        {(canRestore || page?.next_offset != null || offset > 0) && (
          <div className="history-actions">
            {canRestore && (
              <button
                className="button small primary"
                disabled={ws.busy}
                onClick={() => {
                  void ws
                    .action(() => restoreFinding(projectId, nodeId))
                    .then((ok) => {
                      if (ok) onClose();
                    });
                }}
              >
                恢复此发现
              </button>
            )}
            <span className="spacer" />
            {(page?.next_offset != null || offset > 0) && (
              <>
                <button
                  className="button small"
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 4000))}
                >
                  上一页
                </button>
                <span className="quiet">
                  {offset} / {page?.total_chars?.toLocaleString("zh-CN") ?? "—"} 字符
                </span>
                <button
                  className="button small"
                  disabled={page?.next_offset == null}
                  onClick={() => setOffset(page!.next_offset!)}
                >
                  下一页
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

export function GraphReference({
  nodeId,
  onSelect,
  className,
}: {
  nodeId: string;
  onSelect(): void;
  className?: string;
}) {
  const ws = useWorkspace(),
    [history, setHistory] = useState(false);
  const graph = ws.visible ?? ws.graph;
  const removed = graph?.deleted_nodes?.some((ref) => ref.id === nodeId);
  const reference = nodeReference(graph ?? undefined, nodeId);
  const title = `${reference.kind} ${nodeId}${reference.text ? ` · ${reference.text}` : ""}${removed ? " · 已删除" : ""}`;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`${nodeId}${removed ? " · 已删除" : ""}`}
        title={removed ? `来源节点已删除，查看保留的原始历史（${title}）` : title}
        onClick={() => (removed ? setHistory(true) : onSelect())}
      >
        {reference.text ? (
          <>
            <span className="ref-kind">{reference.kind}</span>
            <span className="ref-text">{reference.text}</span>
          </>
        ) : (
          <span className="ref-text">{nodeId}</span>
        )}
        {removed && <span className="ref-state">已删除</span>}
      </button>
      {history && <NodeHistoryDrawer nodeId={nodeId} onClose={() => setHistory(false)} />}
    </>
  );
}

function dayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function DeletedNodeHistory() {
  const ws = useWorkspace(),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string>(),
    [filter, setFilter] = useState<"all" | DeletedNodeRef["kind"]>("all");
  const refs = ws.graph?.deleted_nodes ?? [];
  if (!refs.length) return null;
  const restorable = refs.filter((ref) => ref.kind === "findings").length;
  const counts = new Map<DeletedNodeRef["kind"], number>();
  for (const ref of refs) counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1);
  const effective = filter !== "all" && counts.has(filter) ? filter : "all";
  const shown = (effective === "all" ? refs : refs.filter((ref) => ref.kind === effective))
    .slice()
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || b.id.localeCompare(a.id));
  const groups: { key: string; label: string; items: DeletedNodeRef[] }[] = [];
  for (const ref of shown) {
    const key = dayKey(ref.deleted_at);
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(ref);
    else groups.push({ key, label: fmtDay(ref.deleted_at), items: [ref] });
  }
  return (
    <>
      <button
        className="board-history"
        aria-label={`删除历史 ${refs.length}`}
        title={
          restorable
            ? `查看 ${refs.length} 个已删除节点，其中 ${restorable} 个发现可恢复`
            : `查看 ${refs.length} 个已删除节点的保留原文`
        }
        onClick={() => setOpen(true)}
      >
        <Archive size={13} aria-hidden="true" />
        <span>删除历史</span>
        <span className="board-history-count">{refs.length}</span>
        {restorable > 0 && <span className="board-history-dot" aria-hidden="true" />}
      </button>
      {open && (
        <Drawer label="删除历史" title={`已删除节点 · ${refs.length}`} width={520} onClose={() => setOpen(false)}>
          <p className="deleted-intro">
            删除只隐藏当前图；原文、来源和删除理由可从历史读取。发现可以由操作者恢复，其他节点只保留历史。
          </p>
          {counts.size > 1 && (
            <div className="deleted-filters" role="group" aria-label="按类型筛选">
              <button
                type="button"
                className={effective === "all" ? "active" : ""}
                aria-pressed={effective === "all"}
                onClick={() => setFilter("all")}
              >
                全部 <span>{refs.length}</span>
              </button>
              {[...counts.entries()].map(([kind, total]) => (
                <button
                  type="button"
                  key={kind}
                  className={effective === kind ? "active" : ""}
                  aria-pressed={effective === kind}
                  onClick={() => setFilter(kind)}
                >
                  {kindLabels[kind] || kind} <span>{total}</span>
                </button>
              ))}
            </div>
          )}
          <div className="deleted-groups">
            {groups.map((group) => (
              <section className="deleted-group" key={group.key} aria-label={group.label}>
                <h3 className="deleted-day">
                  {group.label}
                  <span>{group.items.length} 项</span>
                </h3>
                <ul className="deleted-list">
                  {group.items.map((ref) => (
                    <li className="deleted-item" key={ref.id}>
                      <button
                        type="button"
                        className="deleted-row"
                        aria-label={`读取历史 ${ref.id}`}
                        title={`读取 ${ref.id} 的保留原文`}
                        onClick={() => {
                          setOpen(false);
                          setSelected(ref.id);
                        }}
                      >
                        <span className="deleted-kind" data-kind={ref.kind}>
                          {kindLabels[ref.kind] || ref.kind}
                        </span>
                        <code className="deleted-id">{ref.id}</code>
                        <time className="deleted-time" dateTime={ref.deleted_at}>
                          {fmtTime(ref.deleted_at)}
                        </time>
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                      {ref.kind === "findings" && (
                        <button
                          type="button"
                          className="button small primary deleted-restore"
                          disabled={ws.busy}
                          onClick={() => void ws.action(() => restoreFinding(ws.id!, ref.id))}
                        >
                          恢复
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!shown.length && <p className="deleted-empty">没有该类型的删除记录。</p>}
          </div>
        </Drawer>
      )}
      {selected && <NodeHistoryDrawer key={selected} nodeId={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
