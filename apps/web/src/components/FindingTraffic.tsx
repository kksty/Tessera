import { useEffect, useState } from "react";
import { ArrowUpRight, Radio, RefreshCw } from "lucide-react";
import type { Finding } from "../../../../packages/protocol/src/index.js";
import type { FindingTraffic, TrafficSummary } from "../../../../packages/protocol/src/traffic.js";
import { api, path } from "../api.js";
import { fmtTime } from "../format.js";
import { Skeleton } from "./ui.js";
import { useWorkspace } from "../workspace.js";

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

function statusTone(status: number) {
  if (status >= 500) return "danger";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "success";
}

/** Whether a Finding plausibly came from an HTTP request and should show the panel. */
export function hasHttpTrafficHint(finding: Finding) {
  if (finding.traffic_ids?.length) return true;
  const identity = finding.identity;
  if (identity?.method || identity?.path || identity?.location) return true;
  return /(?:https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/)/i.test(
    [
      finding.title,
      finding.description,
      finding.evidence,
      finding.reproduction?.observed,
      ...(finding.reproduction?.steps || []),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function FindingTrafficPanel({ finding }: { finding: Finding }) {
  const ws = useWorkspace();
  const [data, setData] = useState<FindingTraffic | null>(null);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const linkedKey = (finding.traffic_ids || []).join(",");

  useEffect(() => {
    let stopped = false;
    const project = ws.id;
    if (!project) return;
    setError("");
    setData(null);
    setRefreshing(true);
    api<FindingTraffic>(path(project, `/findings/${encodeURIComponent(finding.id)}/traffic`))
      .then((value) => {
        if (!stopped) setData(value);
      })
      .catch((failure: unknown) => {
        if (!stopped) setError(messageOf(failure));
      })
      .finally(() => {
        if (!stopped) setRefreshing(false);
      });
    return () => {
      stopped = true;
    };
  }, [ws.id, finding.id, linkedKey, refreshToken]);

  const records: TrafficSummary[] = data?.records || [];
  const linked = data?.source === "linked";

  return (
    <section className="fd-section finding-traffic" aria-label="真实流量">
      <header className="fd-section-head">
        <h3>
          <Radio size={14} aria-hidden="true" />
          真实流量
        </h3>
        <span>
          {data === null
            ? error
              ? "读取失败"
              : "读取中…"
            : linked
              ? `已关联 ${records.length} 条`
              : records.length
                ? `自动匹配 ${records.length} 条`
                : "未关联"}
        </span>
        <button
          type="button"
          className="button ghost small"
          disabled={refreshing}
          title="重新匹配录制的 HTTP 流量"
          onClick={() => setRefreshToken((value) => value + 1)}
        >
          <RefreshCw size={12} className={refreshing ? "spin" : undefined} aria-hidden="true" />
          刷新
        </button>
      </header>

      {error && (
        <p className="traffic-bad" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <Skeleton rows={2} />}
      {data && !records.length && (
        <div className="finding-traffic-empty">
          <p>没有找到这个发现的 HTTP 流量。录制代理关闭、请求绕过代理，或流量尚未上传时会这样。</p>
          <button type="button" className="button small" onClick={() => ws.navigate("traffic")}>
            打开流量页
          </button>
        </div>
      )}
      {records.length > 0 && (
        <>
          <p className="finding-traffic-note">
            {linked
              ? "执行者关联的原始 HTTP 请求。点击任意一条，直接打开抓包视图查看完整报文。"
              : "按来源任务和入口自动匹配到的原始 HTTP 请求。点击任意一条，直接打开抓包视图。"}
          </p>
          <div className="finding-traffic-list">
            {records.map((record) => (
              <button
                type="button"
                className="finding-traffic-row"
                key={record.id}
                title={`${record.url}\n点击查看完整请求与响应`}
                onClick={() =>
                  ws.openTraffic({
                    flowId: record.id,
                    findingId: finding.id,
                    label: `${finding.id} · v${finding.version}`,
                  })
                }
              >
                <span className="traffic-method-chip" data-method={record.method.toUpperCase()}>
                  {record.method}
                </span>
                <span className="finding-traffic-url mono">{record.url}</span>
                <span className="traffic-code mono" data-tone={record.status ? statusTone(record.status) : undefined}>
                  {record.status || (record.error ? "失败" : "—")}
                </span>
                <span className="finding-traffic-time">{fmtTime(record.created_at)}</span>
                <ArrowUpRight size={13} className="finding-traffic-open" aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
