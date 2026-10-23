import { useCallback, useEffect, useState } from "react";
import type { Run } from "../../../packages/protocol/src/index.js";
import { api, path } from "./api.js";

/**
 * 运行记录轮询。任务页的「需关注」计数和运行列表共用同一份数据，
 * 避免两个视图各自判断“这条运行还算不算待处理”。
 */
export function useRuns(projectId: string, limit: number) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<Run[]>(path(projectId, `/runs?limit=${limit}`));
        if (!active) return;
        setRuns(result);
        setError("");
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "运行记录读取失败");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, limit, tick]);
  return { runs, error, reload };
}
