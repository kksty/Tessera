import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolUsageReport } from "../../../packages/protocol/src/tool-usage.js";
import { api, path } from "./api.js";

/**
 * 项目级工具调用排行。诊断事件在 Run 结束时随图版本一起被看到，
 * 因此按 revision 重取；刷新按钮用于查看正在进行的 Run。
 */
export function useToolUsage(projectId: string, revision: number) {
  const [report, setReport] = useState<ToolUsageReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const request = useRef(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    setError("");
    api<ToolUsageReport>(path(projectId, "/tool-usage"))
      .then((next) => {
        if (id !== request.current) return;
        setReport(next);
      })
      .catch((failure) => {
        if (id !== request.current) return;
        setError(failure instanceof Error ? failure.message : "工具统计读取失败");
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  }, [projectId, revision, tick]);

  return { report, error, loading, reload };
}
