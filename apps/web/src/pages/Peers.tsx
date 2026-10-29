import { AlertCircle, MessagesSquare, RefreshCw, RotateCcw, Users } from "lucide-react";
import { useState } from "react";
import type { Peer, SwarmRound } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { Card, EmptyState, PageHeader } from "../components/ui.js";
import { useSwarm } from "../swarm.js";
import { useWorkspace } from "../workspace.js";

const wakeLabels: Record<string, string> = { ready: "可唤醒", waiting: "等待唤醒", stuck: "已停顿（需人工重试）" };
const opinionLabels: Record<string, string> = { agree: "同意", disagree: "反对", unsure: "不确定" };
const opinionTone: Record<string, string> = { agree: "success", disagree: "danger", unsure: "warn" };

function peerStatus(peer: Peer) {
  return peer.status === "active" ? { tone: "accent", label: "在岗" } : { tone: "neutral", label: "已退出" };
}

function roundStatus(round: SwarmRound) {
  if (round.status === "committed") return { tone: "success", label: "已达成" };
  if (round.status === "invalidated") return { tone: "warn", label: "已失效" };
  return { tone: "accent", label: "征集中" };
}

/** 一行状态药丸，复用现有 status-pill 样式。 */
function Pill({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="status-pill" data-tone={tone}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

export function PeersPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = graph.project.id;
  const { data, error, reload } = useSwarm(projectId, graph.revision, ws.events.length);
  const [retrying, setRetrying] = useState<string>("");
  const [actionError, setActionError] = useState("");

  async function retryPeer(peerId: string) {
    setRetrying(peerId);
    setActionError("");
    try {
      await api(path(projectId, `/fgs/peers/${peerId}/retry`), { confirmed: true });
      reload();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "重试失败");
    } finally {
      setRetrying("");
    }
  }

  const peers = data?.peers ?? [];
  const active = peers.filter((peer) => peer.status === "active");
  const rounds = [...(data?.rounds ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const messages = [...(data?.messages ?? [])].sort((a, b) => a.seq - b.seq);
  const openRound = rounds.find((round) => round.status === "open");

  return (
    <section className="page page-peers">
      <PageHeader
        eyebrow="PROJECT / PEERS"
        title="执行者"
        description="平等执行者自主定向、互相通信、自行裂变与退出；没有决策者，也没有 Step。完成需要全体共识并清空审核与覆盖缺口。"
        actions={
          <button type="button" className="button" disabled={ws.refreshing} onClick={reload}>
            <RefreshCw size={13} className={ws.refreshing ? "spin" : ""} aria-hidden="true" />
            刷新
          </button>
        }
        meta={
          <>
            <span className="meta-pill">
              <Users size={13} aria-hidden="true" />
              在岗 {active.length} / 共 {peers.length}
            </span>
            <span className="meta-pill">
              <MessagesSquare size={13} aria-hidden="true" />
              {messages.length} 条消息
            </span>
            <span className="meta-pill" title="有未表态的共识轮次时完成任务会被阻塞">
              {openRound ? "共识征集中" : "无进行中的共识"}
            </span>
          </>
        }
      />

      {error && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {actionError && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      <Card title="执行者" note={peers.length ? `${active.length} 个在岗` : undefined} icon={<Users size={16} />} flush>
        {peers.length ? (
          <div className="data-table-wrap">
            <table className="data-table peers-table">
              <thead>
                <tr>
                  <th scope="col">执行者</th>
                  <th scope="col">状态</th>
                  <th scope="col">方向</th>
                  <th scope="col" className="num">
                    回合
                  </th>
                  <th scope="col">唤醒</th>
                  <th scope="col">来源 / 血缘</th>
                </tr>
              </thead>
              <tbody>
                {peers.map((peer) => {
                  const status = peerStatus(peer);
                  return (
                    <tr key={peer.id}>
                      <td className="mono">{peer.id}</td>
                      <td>
                        <Pill tone={status.tone} label={status.label} />
                      </td>
                      <td className="peers-direction">
                        {peer.direction || <span className="quiet">尚未声明方向</span>}
                      </td>
                      <td className="num" data-label="回合">
                        {peer.state?.turns ?? 0}
                      </td>
                      <td>
                        {peer.state?.wake === "stuck" ? (
                          <span
                            className="peers-stuck"
                            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                          >
                            <span className="quiet">{wakeLabels.stuck}</span>
                            <button
                              type="button"
                              className="button small"
                              disabled={retrying === peer.id}
                              onClick={() => void retryPeer(peer.id)}
                            >
                              <RotateCcw size={12} className={retrying === peer.id ? "spin" : ""} aria-hidden="true" />
                              重试
                            </button>
                          </span>
                        ) : (
                          <span className="quiet">
                            {peer.state ? wakeLabels[peer.state.wake] || peer.state.wake : "—"}
                          </span>
                        )}
                      </td>
                      <td className="peers-origin">
                        <span className="tag">{peer.origin === "initial" ? "初始" : "裂变"}</span>
                        {peer.parent_peer_id && <span className="quiet">来自 {peer.parent_peer_id}</span>}
                        {peer.spawn_reason && <span className="quiet"> · {peer.spawn_reason}</span>}
                        {peer.status === "retired" && peer.retire_reason && (
                          <span className="quiet"> · 退出：{peer.retire_reason}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Users size={20} />}
            title="还没有执行者"
            desc="swarm 项目启动后会创建一个初始执行者，它可自行裂变出更多同伴。"
          />
        )}
      </Card>

      <Card title="共识轮次" note={rounds.length ? `${rounds.length} 轮` : undefined} flush>
        {rounds.length ? (
          <div className="data-table-wrap">
            <table className="data-table peers-table">
              <thead>
                <tr>
                  <th scope="col">轮次</th>
                  <th scope="col">状态</th>
                  <th scope="col">发起者</th>
                  <th scope="col">参与者</th>
                  <th scope="col">表态</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((round) => {
                  const status = roundStatus(round);
                  const opinions = Object.entries(round.opinions);
                  return (
                    <tr key={round.id}>
                      <td className="mono">{round.id}</td>
                      <td>
                        <Pill tone={status.tone} label={status.label} />
                      </td>
                      <td className="mono">{round.proposer_peer_id}</td>
                      <td className="peers-participants">
                        {round.peer_ids.length ? round.peer_ids.join(" · ") : <span className="quiet">—</span>}
                      </td>
                      <td className="peers-opinions">
                        {opinions.length ? (
                          opinions.map(([peerId, value]) => (
                            <span key={peerId} className="peers-opinion" title={value.note || undefined}>
                              <span className="mono">{peerId}</span>
                              <Pill
                                tone={opinionTone[value.opinion] || "neutral"}
                                label={opinionLabels[value.opinion] || value.opinion}
                              />
                            </span>
                          ))
                        ) : (
                          <span className="quiet">尚无表态</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="还没有共识轮次"
            desc="任一执行者提议完成后会开启一轮共识，全体明确同意且无在途活动时才提交。"
          />
        )}
      </Card>
    </section>
  );
}
