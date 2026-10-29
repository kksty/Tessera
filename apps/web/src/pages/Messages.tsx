import { useMemo, useState } from "react";
import { AlertCircle, MessagesSquare, RefreshCw, Search } from "lucide-react";
import type { Peer, PeerMessage } from "../../../../packages/protocol/src/index.js";
import { EmptyState, PageHeader, Segmented } from "../components/ui.js";
import { fromNow } from "../format.js";
import { useSwarm } from "../swarm.js";
import { fmt, useWorkspace } from "../workspace.js";

const kindLabels: Record<string, string> = {
  share: "分享",
  question: "提问",
  reply: "回复",
  handoff: "交接",
  notice: "通知",
  system: "系统",
};

/** 一条消息的收件人标签：广播或具体执行者。 */
function audience(message: PeerMessage, peers: Map<string, Peer>) {
  if (!message.to_peer) return { label: "全体", broadcast: true };
  return { label: peers.get(message.to_peer)?.id ?? message.to_peer, broadcast: false };
}

export function MessagesPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = graph.project.id;
  const { data, error, reload } = useSwarm(projectId, graph.revision, ws.events.length);

  const [scope, setScope] = useState<"all" | "broadcast" | "directed">("all");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");

  const peers = data?.peers ?? [];
  const peerById = useMemo(() => new Map(peers.map((peer) => [peer.id, peer])), [peers]);
  const all = useMemo(() => [...(data?.messages ?? [])].sort((a, b) => b.seq - a.seq), [data]);
  const broadcastCount = all.filter((message) => !message.to_peer).length;
  const directedCount = all.length - broadcastCount;
  const kinds = useMemo(() => [...new Set(all.map((message) => message.kind))], [all]);

  const needle = query.trim().toLowerCase();
  const messages = all.filter((message) => {
    if (scope === "broadcast" && message.to_peer) return false;
    if (scope === "directed" && !message.to_peer) return false;
    if (kind && message.kind !== kind) return false;
    if (needle) {
      const haystack = [
        message.from_peer ?? "",
        message.to_peer ?? "全体",
        kindLabels[message.kind] ?? message.kind,
        message.body,
        ...message.refs,
        `#${message.seq}`,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return (
    <section className="page page-messages">
      <PageHeader
        eyebrow="PROJECT / MESSAGES"
        title="消息"
        description="执行者之间互相投递的消息（广播或定向）。这里展示最近 1000 条（更早的消息按有界保留策略裁剪）；每个执行者自己只能读取发给它的收件箱。"
        actions={
          <button type="button" className="button" disabled={ws.refreshing} onClick={reload}>
            <RefreshCw size={13} className={ws.refreshing ? "spin" : ""} aria-hidden="true" />
            刷新
          </button>
        }
        meta={
          <>
            <span className="meta-pill">
              <MessagesSquare size={13} aria-hidden="true" />共 {all.length} 条
            </span>
            <span className="meta-pill">广播 {broadcastCount}</span>
            <span className="meta-pill">定向 {directedCount}</span>
            <span className="meta-pill">{peers.filter((peer) => peer.status === "active").length} 个在岗执行者</span>
          </>
        }
      />

      {error && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="toolbar">
        <label className="search-input">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索消息"
            placeholder="搜索发送者、收件人、正文或引用 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Segmented
          ariaLabel="投递范围"
          value={scope}
          onChange={setScope}
          options={
            [
              ["all", "全部"],
              ["broadcast", "广播"],
              ["directed", "定向"],
            ] as const
          }
        />
        <select
          className="select-compact"
          aria-label="消息类型"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">全部类型</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {kindLabels[value] ?? value}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span className="toolbar-hint">
          显示 {messages.length} / {all.length} 条
        </span>
      </div>

      {messages.length ? (
        <ol className="timeline-list messages-list">
          {messages.map((message) => {
            const target = audience(message, peerById);
            return (
              <li className="timeline-row" key={`${message.seq}:${message.id}`}>
                <span className="timeline-dot" aria-hidden="true" />
                <div className="timeline-main">
                  <div className="timeline-head">
                    <time className="timeline-time mono" dateTime={message.created_at}>
                      {fmt(message.created_at)}
                    </time>
                    <strong className="timeline-title">
                      {message.from_peer ?? "系统"} → {target.label}
                    </strong>
                    <span className={target.broadcast ? "tag tag-accent" : "tag"}>
                      {target.broadcast ? "广播" : "定向"}
                    </span>
                  </div>
                  <div className="timeline-meta">
                    <span className="tag">#{message.seq}</span>
                    <span>{kindLabels[message.kind] ?? message.kind}</span>
                    <span className="quiet">{fromNow(message.created_at)}</span>
                  </div>
                  <p className="timeline-detail">{message.body}</p>
                  {message.refs.length > 0 && (
                    <div className="timeline-targets">
                      {message.refs.map((ref) => (
                        <span className="timeline-chip mono" key={ref} title={ref}>
                          {ref}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState
          icon={<MessagesSquare size={20} />}
          title={all.length ? "没有符合条件的消息" : "还没有消息"}
          desc={
            all.length
              ? "调整搜索或筛选条件试试。"
              : "执行者之间发出或接收的消息会按序号出现在这里；广播消息的收件人为「全体」。"
          }
        />
      )}
    </section>
  );
}
