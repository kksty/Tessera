import { CoverageEntry, Step } from "./models-core.js";
import { Review, ReviewIssueDisposition } from "./models-finding.js";

/**
 * 任务架构模式。缺省（含旧项目）为 classic：Decide/Execute/Review 三类任务。
 * swarm：无决策者、无 Step，多个平等 peer 自主定向、互相通信、自主裂变。
 * 创建时选定，持久不可变，中途不可切换。
 */
export type ProjectMode = "classic" | "swarm";

/**
 * swarm 模式的平等执行者。只保存持久身份与状态；回合租约、已读水位等易变
 * 协调状态在 project_peer_state 表，避免心跳推进图版本唤醒所有 peer。
 */
export interface Peer {
  id: string;
  graph_id: string;
  origin: "initial" | "spawn" | "operator";
  /** 裂变出处；只是血缘记录，不产生任何指挥权。 */
  parent_peer_id?: string;
  spawn_reason?: string;
  /** 自报的当前方向（≤200 字），同伴与操作员可见。 */
  direction?: string;
  status: "active" | "retired";
  created_at: string;
  retired_at?: string;
  retire_reason?: string;
}

/** swarm 完成共识轮次。revision/message_seq/参与者集合任一变化即失效。 */
export interface SwarmRound {
  id: string;
  graph_id: string;
  proposer_peer_id: string;
  reason?: string;
  /** 提议时的图版本与消息水位；用于判定轮次是否仍然有效。 */
  revision: number;
  message_seq: number;
  /** 提议时的 active peer 集合快照。 */
  peer_ids: string[];
  opinions: Record<string, { opinion: "agree" | "disagree" | "unsure"; note?: string; at: string }>;
  status: "open" | "committed" | "invalidated";
  created_at: string;
  closed_at?: string;
  close_reason?: string;
  /** 提议时提交的覆盖表（每个 host+path 必须 tested/waived/na）。 */
  coverage?: CoverageEntry[];
  /** 提议时逐条处置的当前 Review 问题；未处置的有效问题会拒绝提议。 */
  review_issues?: ReviewIssueDisposition[];
}

/** peer 间消息；持久化在 project_messages 表，不进入图集合。to_peer 为空为广播。 */
export interface PeerMessage {
  id: string;
  seq: number;
  from_peer: string | null;
  to_peer: string | null;
  kind: "share" | "question" | "reply" | "handoff" | "notice" | "system";
  body: string;
  refs: string[];
  created_at: string;
}

/** project_peer_state 表记录：回合调度与投递水位。 */
export interface PeerState {
  peer_id: string;
  /**
   * ready = 下回合立即可领取；waiting = 仅新消息/图变化/新轮次唤醒；
   * stuck = 连续业务失败被自动停下，只能由操作员手动重试（见 peer.retry）。
   */
  wake: "ready" | "waiting" | "stuck";
  seen_revision: number;
  seen_message_seq: number;
  turns: number;
  last_turn_at?: string;
  /** 上一回合摘要。 */
  summary?: string;
}
