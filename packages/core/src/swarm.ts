import type { DatabaseSync } from "node:sqlite";
import type { Graph, Peer, PeerMessage, PeerState, SwarmRound } from "../../protocol/src/models.js";

/**
 * swarm 模式的两张易变协调表。刻意不放进 FGS 图集合：回合心跳、已读水位、
 * 消息投递这类高频变化若进入图，会持续推进 revision 并唤醒所有 peer。
 * 图只保存持久身份（Peer）与共识轮次（SwarmRound）。
 */
export class SwarmRecords {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_messages(
        project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, id TEXT NOT NULL,
        from_peer TEXT, to_peer TEXT, kind TEXT NOT NULL,
        body TEXT NOT NULL, refs TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, seq));
      CREATE INDEX IF NOT EXISTS project_message_project ON project_messages(project_id, seq);
      CREATE TABLE IF NOT EXISTS project_peer_state(
        project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
        peer_id TEXT NOT NULL,
        wake TEXT NOT NULL,
        seen_revision INTEGER NOT NULL,
        seen_message_seq INTEGER NOT NULL,
        turn_start_revision INTEGER NOT NULL DEFAULT 0,
        turn_start_message_seq INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        last_turn_at TEXT,
        summary TEXT,
        PRIMARY KEY(project_id, peer_id));
    `);
  }
  maxSeq(projectId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM project_messages WHERE project_id=?")
      .get(projectId);
    return Number(row?.n ?? 0);
  }
  append(
    projectId: string,
    input: { from: string | null; to: string | null; kind: PeerMessage["kind"]; body: string; refs: string[] },
  ): PeerMessage {
    const seq = this.maxSeq(projectId) + 1;
    const message: PeerMessage = {
      id: `m${String(seq).padStart(6, "0")}`,
      seq,
      from_peer: input.from,
      to_peer: input.to,
      kind: input.kind,
      body: input.body,
      refs: input.refs,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO project_messages VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        projectId,
        message.seq,
        message.id,
        message.from_peer,
        message.to_peer,
        message.kind,
        message.body,
        JSON.stringify(message.refs),
        message.created_at,
      );
    return message;
  }
  list(projectId: string, afterSeq = 0, limit = 500): PeerMessage[] {
    return this.db
      .prepare("SELECT * FROM project_messages WHERE project_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(projectId, afterSeq, limit)
      .map((row) => ({
        id: String(row.id),
        seq: Number(row.seq),
        from_peer: row.from_peer === null ? null : String(row.from_peer),
        to_peer: row.to_peer === null ? null : String(row.to_peer),
        kind: String(row.kind) as PeerMessage["kind"],
        body: String(row.body),
        refs: JSON.parse(String(row.refs)),
        created_at: String(row.created_at),
      }));
  }
  /** Messages addressed to a peer: broadcast (to_peer IS NULL) or directed at it, excluding its own echoes. */
  inbox(projectId: string, peerId: string, afterSeq = 0, limit = 200): PeerMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM project_messages WHERE project_id=? AND seq>? AND (to_peer IS NULL OR to_peer=?) AND (from_peer IS NULL OR from_peer<>?) ORDER BY seq LIMIT ?",
      )
      .all(projectId, afterSeq, peerId, peerId, limit)
      .map((row) => ({
        id: String(row.id),
        seq: Number(row.seq),
        from_peer: row.from_peer === null ? null : String(row.from_peer),
        to_peer: row.to_peer === null ? null : String(row.to_peer),
        kind: String(row.kind) as PeerMessage["kind"],
        body: String(row.body),
        refs: JSON.parse(String(row.refs)),
        created_at: String(row.created_at),
      }));
  }
  states(projectId: string): Map<string, PeerState> {
    const map = new Map<string, PeerState>();
    for (const row of this.db.prepare("SELECT * FROM project_peer_state WHERE project_id=?").all(projectId)) {
      map.set(String(row.peer_id), {
        peer_id: String(row.peer_id),
        wake: String(row.wake) as PeerState["wake"],
        seen_revision: Number(row.seen_revision),
        seen_message_seq: Number(row.seen_message_seq),
        turns: Number(row.turns),
        last_turn_at: row.last_turn_at == null ? undefined : String(row.last_turn_at),
        summary: row.summary == null ? undefined : String(row.summary),
      });
    }
    return map;
  }
  state(projectId: string, peerId: string): PeerState {
    const row = this.db
      .prepare("SELECT * FROM project_peer_state WHERE project_id=? AND peer_id=?")
      .get(projectId, peerId);
    if (!row) return { peer_id: peerId, wake: "ready", seen_revision: 0, seen_message_seq: 0, turns: 0 };
    return {
      peer_id: String(row.peer_id),
      wake: String(row.wake) as PeerState["wake"],
      seen_revision: Number(row.seen_revision),
      seen_message_seq: Number(row.seen_message_seq),
      turns: Number(row.turns),
      last_turn_at: row.last_turn_at == null ? undefined : String(row.last_turn_at),
      summary: row.summary == null ? undefined : String(row.summary),
    };
  }
  /** 回合开始时冻结交付水位：turn-end 把这两个值写回 seen_*，保证消息至少投递一次。 */
  startTurn(projectId: string, peerId: string, revision: number): PeerState {
    const seq = this.maxSeq(projectId);
    const current = this.state(projectId, peerId);
    const next: PeerState = { ...current, turns: current.turns + 1, last_turn_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO project_peer_state
          (project_id,peer_id,wake,seen_revision,seen_message_seq,turn_start_revision,turn_start_message_seq,turns,last_turn_at,summary)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id,peer_id) DO UPDATE SET
          wake=excluded.wake, turns=excluded.turns, last_turn_at=excluded.last_turn_at,
          turn_start_revision=excluded.turn_start_revision, turn_start_message_seq=excluded.turn_start_message_seq`,
      )
      .run(
        projectId,
        peerId,
        current.wake,
        current.seen_revision,
        current.seen_message_seq,
        revision,
        seq,
        next.turns,
        next.last_turn_at ?? null,
        current.summary ?? null,
      );
    return { ...next, seen_revision: current.seen_revision, seen_message_seq: current.seen_message_seq };
  }
  /**
   * turn-end：seen_message_seq 用本回合实际投递给该 peer 的最大 seq（没有新消息则保持原值），
   * 这样即便 inbox 分页/上限截断，剩余消息下回合仍会再投递，不会静默丢失；
   * seen_revision 用回合结束时的当前图版本，避免本回合自己写入的事实立刻把自己再唤醒一轮。
   */
  finishTurn(
    projectId: string,
    peerId: string,
    input: { wake: PeerState["wake"]; summary?: string; seenMessageSeq?: number },
    revision?: number,
  ): void {
    const row = this.db
      .prepare("SELECT * FROM project_peer_state WHERE project_id=? AND peer_id=?")
      .get(projectId, peerId);
    if (!row) return;
    this.db
      .prepare(
        `UPDATE project_peer_state SET wake=?, last_turn_at=?, seen_revision=COALESCE(?, turn_start_revision),
          seen_message_seq=MAX(COALESCE(?, seen_message_seq), seen_message_seq), summary=? WHERE project_id=? AND peer_id=?`,
      )
      .run(
        input.wake,
        new Date().toISOString(),
        revision ?? null,
        input.seenMessageSeq && input.seenMessageSeq > 0 ? input.seenMessageSeq : null,
        input.summary ?? null,
        projectId,
        peerId,
      );
  }
  /**
   * 设置唤醒状态。用 UPSERT 而不是 UPDATE：刚裂变出来、还没跑过回合的 peer 没有
   * project_peer_state 行，UPDATE 会静默失效，执行者页会显示成“无状态”。
   */
  setWake(projectId: string, peerId: string, wake: PeerState["wake"]): void {
    this.db
      .prepare(
        `INSERT INTO project_peer_state
          (project_id,peer_id,wake,seen_revision,seen_message_seq,turn_start_revision,turn_start_message_seq,turns,last_turn_at,summary)
         VALUES(?,?,?,0,0,0,0,0,NULL,NULL)
         ON CONFLICT(project_id,peer_id) DO UPDATE SET wake=excluded.wake`,
      )
      .run(projectId, peerId, wake);
  }
  /** 共识提交后让所有 peer 停在当前版本，避免提交动作本身引起再唤醒。 */
  parkAll(projectId: string, revision: number): void {
    this.db
      .prepare("UPDATE project_peer_state SET wake='waiting', seen_revision=? WHERE project_id=?")
      .run(revision, projectId);
  }
  /**
   * 删除已被所有在岗 peer 确认投递（seen_message_seq 以下）的旧消息，把只增不改的
   * 消息日志限制在运营可读窗口内。调用方负责用活跃 peer 的已读水位算出上界，
   * 保证不会删除任何尚未投递的消息。返回删除行数。
   */
  deleteThrough(projectId: string, throughSeq: number): number {
    if (throughSeq <= 0) return 0;
    const info = this.db
      .prepare("DELETE FROM project_messages WHERE project_id=? AND seq<=?")
      .run(projectId, throughSeq);
    return Number(info.changes || 0);
  }
  /** 清掉图里已不存在的 peer 的回合水位行，避免状态表随历史 peer 无界增长。 */
  retainPeerStates(projectId: string, peerIds: string[]): number {
    if (!peerIds.length) {
      const info = this.db.prepare("DELETE FROM project_peer_state WHERE project_id=?").run(projectId);
      return Number(info.changes || 0);
    }
    const placeholders = peerIds.map(() => "?").join(",");
    const info = this.db
      .prepare(`DELETE FROM project_peer_state WHERE project_id=? AND peer_id NOT IN (${placeholders})`)
      .run(projectId, ...peerIds);
    return Number(info.changes || 0);
  }
}

export function activePeers(graph: Graph): Peer[] {
  return (graph.peers ?? []).filter((peer) => peer.status === "active");
}

export function peerId(peers: { id: string }[]): string {
  const used = new Set(peers.map((p) => p.id));
  let n = 1;
  while (used.has(`p${String(n).padStart(3, "0")}`)) n++;
  return `p${String(n).padStart(3, "0")}`;
}

export function roundId(rounds: { id: string }[]): string {
  const used = new Set(rounds.map((r) => r.id));
  let n = 1;
  while (used.has(`c${String(n).padStart(3, "0")}`)) n++;
  return `c${String(n).padStart(3, "0")}`;
}

export function openRound(graph: Graph): SwarmRound | undefined {
  return (graph.rounds ?? []).find((round) => round.status === "open");
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * A round only stays meaningful while the shared state it was opened against is
 * unchanged: same graph revision, same message high-watermark, same participants.
 * Any message, node change, peer join/leave invalidates it without an explicit write.
 */
export function roundValid(graph: Graph, round: SwarmRound, messageSeq: number, activeIds: string[]): boolean {
  return (
    round.status === "open" &&
    round.revision === graph.revision &&
    round.message_seq === messageSeq &&
    sameSet(round.peer_ids, activeIds)
  );
}

/** A peer is due for a turn when it is not mid-turn and something it has not seen changed. */
export function peerTurnDue(graph: Graph, peer: Peer, state: PeerState, hasUnread: boolean): boolean {
  if (peer.status !== "active") return false;
  // stuck 是操作员闸门：连续失败后停下，只有 peer.retry 能解除。
  if (state.wake === "stuck") return false;
  if (state.wake === "ready") return true;
  if (hasUnread) return true;
  if (graph.revision > state.seen_revision) return true;
  const round = openRound(graph);
  if (round && round.peer_ids.includes(peer.id) && !round.opinions[peer.id]) return true;
  return false;
}
