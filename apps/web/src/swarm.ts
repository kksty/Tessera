import { useCallback, useEffect, useState } from "react";
import type { Peer, PeerMessage, PeerState, ProjectMode, SwarmRound } from "../../../packages/protocol/src/index.js";
import { api, path } from "./api.js";

/**
 * `GET /projects/:id/swarm` 的响应：持久 peer、回合状态、消息与共识轮次的合并快照。
 * 消息与 peer 状态不在 FGS 图里（避免心跳推进图版本），所以单独取一次。
 */
export interface SwarmSnapshot {
  mode: ProjectMode;
  peers: (Peer & { state?: PeerState })[];
  rounds: SwarmRound[];
  messages: PeerMessage[];
  max_message_seq: number;
}

/**
 * 执行者页的数据源：随图版本与事件条数变化重新拉取，并按 4 秒兜底轮询。
 * 消息写入会推高事件条数（platform_events → SSE），因此这里能跟着实时刷新。
 */
export function useSwarm(projectId: string, revision: number, eventCount: number) {
  const [data, setData] = useState<SwarmSnapshot | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<SwarmSnapshot>(path(projectId, "/swarm"));
        if (!active) return;
        setData(result);
        setError("");
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "执行者数据读取失败");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, revision, eventCount, tick]);
  return { data, error, reload };
}
