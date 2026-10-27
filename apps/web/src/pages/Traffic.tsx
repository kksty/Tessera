import { Fragment, useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import type { TrafficRecord, TrafficStatus, TrafficSummary } from "../../../../packages/protocol/src/traffic.js";
import { api, path } from "../api.js";
import { TrafficInspector } from "../components/TrafficInspector.js";
import { Drawer, EmptyState, PageHeader, Segmented, Skeleton } from "../components/ui.js";
import { fmt, fmtBytes, fmtTime } from "../format.js";
import { useWorkspace } from "../workspace.js";

type TrafficList = { records: TrafficSummary[]; capture: TrafficStatus };
type Kind = "" | "http" | "connection" | "packet";

const kindLabels: Record<string, string> = { http: "HTTP", connection: "连接", packet: "数据包" };

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** 非 HTTP 记录没有可判定的状态码：连接看生命周期，数据包看聚合数量。 */
function stateLabel(row: TrafficSummary) {
  if (row.error) return "失败";
  if (row.capture_kind === "connection") return row.capture_state === "closed" ? "已结束" : "进行中";
  if (row.capture_kind === "packet") return `累计 ${row.packet_count || 0} 个包`;
  return row.status ? String(row.status) : "请求中";
}

function statusTone(status: number) {
  if (status >= 500) return "danger";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "success";
}

function volumeLabel(row: TrafficSummary) {
  if (row.capture_kind === "connection") return `↑${fmtBytes(row.request_size)} ↓${fmtBytes(row.response_size)}`;
  if (row.capture_kind === "packet") return `${fmtBytes(row.request_size)} · ${row.packet_count || 0} 包`;
  return `${fmtBytes(row.response_size)}${row.truncated ? " *" : ""}`;
}

export function TrafficPage() {
  const ws = useWorkspace();
  const id = ws.id!;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<Kind>("http");
  const [list, setList] = useState<TrafficList | null>(null);
  const [older, setOlder] = useState<TrafficSummary[]>([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [record, setRecord] = useState<TrafficRecord | null>(null);
  const [detailError, setDetailError] = useState("");
  const generation = useRef(0);
  const selection = useRef(0);
  const trafficTarget = ws.trafficTarget;

  // A Finding opens the exact captured flow: select it, force the HTTP view, and
  // let the detail request render the inspector without waiting for the list.
  useEffect(() => {
    if (!trafficTarget?.flowId) return;
    setKind("http");
    setSelected(trafficTarget.flowId);
  }, [trafficTarget]);

  // 搜索防抖：输入停顿 200 ms 后才换查询串，避免每敲一个字都重建轮询。
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 过滤条件变化时清空已加载的历史页，避免新旧结果混在一起。
  useEffect(() => {
    generation.current += 1;
    setOlder([]);
    setList(null);
    setError("");
  }, [id, kind, debounced]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current;
    const url = path(id, `/traffic?limit=200&kind=${kind}&q=${encodeURIComponent(debounced)}`);
    const poll = async () => {
      try {
        const result = await api<TrafficList>(url);
        if (stopped || generation.current !== current) return;
        setList(result);
        setError("");
      } catch (failure) {
        if (!stopped && generation.current === current) setError(messageOf(failure));
      } finally {
        if (!stopped && generation.current === current) setRefreshing(false);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, kind, debounced, refreshToken]);

  const updated = list?.records.find((row) => row.id === selected)?.updated_at;
  useEffect(() => {
    const current = ++selection.current;
    // 轮询刷新同一条记录时保留已渲染内容，只有切换记录才回到骨架。
    setRecord((existing) => (existing && existing.id === selected ? existing : null));
    setDetailError("");
    if (!selected) return;
    api<TrafficRecord>(path(id, `/traffic/${encodeURIComponent(selected)}`))
      .then((value) => {
        if (selection.current === current) setRecord(value);
      })
      .catch((failure: unknown) => {
        if (selection.current === current) setDetailError(messageOf(failure));
      });
    return () => {
      selection.current += 1;
    };
  }, [id, selected, updated]);

  const rows = [...new Map([...(list?.records || []), ...older].map((row) => [row.id, row] as const)).values()].sort(
    (a, b) => b.seq - a.seq,
  );

  async function loadOlder() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    const current = generation.current;
    try {
      const result = await api<TrafficList>(
        path(id, `/traffic?before=${last.seq}&limit=200&kind=${kind}&q=${encodeURIComponent(debounced)}`),
      );
      if (current === generation.current) setOlder((existing) => [...existing, ...result.records]);
    } catch (failure) {
      // The filter may have changed while the older page was in flight; a late
      // failure must not raise an error banner over the new, healthy list.
      if (current === generation.current) setError(messageOf(failure));
    } finally {
      setLoadingMore(false);
    }
  }

  const capture = list?.capture;
  const captureDisabled = ws.config?.capture_enabled === false;
  const projectStatus = ws.graph?.project.status;
  const paused = projectStatus === "stopped" || projectStatus === "completed";
  const stale =
    !paused &&
    (capture?.state === "active" || capture?.state === "degraded") &&
    !!capture?.last_seen &&
    Date.now() - Date.parse(capture.last_seen) > 45_000;
  const captureLabel = captureDisabled
    ? "采集已关闭"
    : paused
      ? projectStatus === "completed"
        ? "采集已结束"
        : "采集已暂停"
      : stale
        ? "采集心跳中断"
        : capture?.state === "degraded"
          ? "采集降级"
          : capture?.state === "active"
            ? "采集中"
            : capture?.state === "starting"
              ? "采集启动中"
              : capture?.state === "unavailable"
                ? "采集不可用"
                : "等待测试运行";
  const captureTone = captureDisabled
    ? "neutral"
    : paused
      ? "neutral"
      : stale
        ? "warn"
        : capture?.state === "degraded"
          ? "warn"
          : capture?.state === "active"
            ? "success"
            : capture?.state === "starting"
              ? "info"
              : capture?.state === "unavailable"
                ? "danger"
                : "neutral";
  const captureTitle = captureDisabled
    ? "录制代理已在设置中关闭；新执行的 Run 不再注入代理，流量不会新增"
    : paused
      ? projectStatus === "completed"
        ? "项目已完成，采集不再新增记录"
        : "项目已暂停，采集不再新增记录"
      : stale
        ? `超过 45 秒未收到心跳（最近 ${fmt(capture?.last_seen)}），记录可能缺失`
        : capture?.last_seen
          ? `最近心跳 ${fmt(capture.last_seen)}`
          : "尚未收到采集状态上报";

  const filtering = debounced.trim() !== "" || (kind !== "" && kind !== "http");
  const captureOff = captureDisabled || (!paused && (capture?.state === "stopped" || capture?.state === "unavailable"));

  const metadata: [string, string][] = record
    ? [
        [
          "类型",
          `${kindLabels[record.capture_kind] || record.capture_kind}${
            record.capture_state
              ? ` · ${record.capture_state === "closed" ? "已结束" : record.capture_state === "error" ? "失败" : "进行中"}`
              : ""
          }`,
        ],
        ["协议", record.protocol],
        ["目标", record.url],
        ["首次记录", fmt(record.created_at)],
        ["最近记录", record.last_seen ? fmt(record.last_seen) : fmt(record.updated_at)],
        ["上行字节", fmtBytes(record.request.size)],
        ["下行字节", fmtBytes(record.response?.size || 0)],
        ["报文 / 数据包", String(record.packet_count ?? 0)],
        ["持续时间", record.duration_ms === null ? "—" : `${Math.round(record.duration_ms)} ms`],
        ["运行", `${record.run_id || "未关联运行"}${record.step_id ? ` · ${record.step_id}` : ""}`],
      ]
    : [];

  return (
    <section className="page page-traffic">
      <PageHeader
        eyebrow="EXPLORATION / TRAFFIC"
        title="流量"
        description="集中录制经录制代理的 HTTP / HTTPS 请求与响应；其他协议和工具自主代理保持原有路径。"
        actions={
          <>
            <span className="status-pill traffic-capture" data-tone={captureTone} title={captureTitle}>
              <i aria-hidden="true" />
              {captureLabel}
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setRefreshToken((value) => value + 1);
              }}
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} aria-hidden="true" />
              刷新
            </button>
          </>
        }
      />

      {trafficTarget?.findingId && (
        <div className="banner traffic-origin" role="status">
          <span className="banner-text">
            来自发现{" "}
            <button type="button" className="link-button" onClick={() => ws.openFinding(id, trafficTarget.findingId!)}>
              {trafficTarget.label || trafficTarget.findingId}
            </button>{" "}
            的真实流量：下面展示执行时录制代理捕获的原始请求与响应。
          </span>
          <button
            type="button"
            className="button ghost small"
            onClick={() => ws.openFinding(id, trafficTarget.findingId!)}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            返回发现
          </button>
        </div>
      )}

      <details className="traffic-scope">
        <summary>
          <ChevronRight size={14} className="traffic-scope-chevron" aria-hidden="true" />
          <span>采集范围与已知缺口</span>
          <small>仅录制经录制代理且识别为 HTTP / HTTPS 的流量 · 只记录，不阻断任务</small>
        </summary>
        <div className="traffic-scope-body">
          <dl className="traffic-scope-list">
            <div>
              <dt>捕获方式</dt>
              <dd>仅录制通过录制代理、且识别为 HTTP / HTTPS 的流量；支持任意目标端口，不根据 80 / 443 判断协议。</dd>
            </div>
            <div>
              <dt>未覆盖</dt>
              <dd>
                工具使用 proxychains4、自主代理、忽略代理环境变量或主动绕过时，HTTP / HTTPS
                可能未被录制。SSH、SMB、数据库和原始探测不采集。
              </dd>
            </div>
            <div>
              <dt>TLS</dt>
              <dd>
                HTTPS 使用受信任的项目 CA 解密；证书固定、双向 TLS 等不兼容连接请使用原连接方式，系统不自动重试请求。
              </dd>
            </div>
            <div>
              <dt>保存</dt>
              <dd>请求与响应正文完整保存，页面分页预览并支持完整下载；不按条数或累计大小自动删除历史。</dd>
            </div>
            <div>
              <dt>故障</dt>
              <dd>存储故障会明确报告保存失败；记录缺失会出现在下方的采集告警里。</dd>
            </div>
            <div>
              <dt>不采集</dt>
              <dd>模型 API、内部调度和心跳不纳入采集。录制代理可配置 HTTP / SOCKS5 上游。</dd>
            </div>
          </dl>
        </div>
      </details>

      {!!capture?.dropped && (
        <div className="banner warn" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>采集报告 {capture.dropped} 次记录缺失，测试继续；请检查采集服务。</span>
        </div>
      )}
      {!!capture?.blocked && (
        <div className="banner warn" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            旧采集策略曾拦截 {capture.blocked} 个 TCP 数据包（非连接数）；新策略只记录，不主动阻断，不阻止任务。
          </span>
        </div>
      )}
      {!captureDisabled && capture?.tls_notice && (
        <div className="banner warn" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{capture.tls_notice}</span>
        </div>
      )}
      {capture?.error && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{capture.error}</span>
        </div>
      )}
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
            aria-label="搜索流量"
            placeholder="搜索 URL、方法、状态或任务 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Segmented
          ariaLabel="流量类型"
          value={kind}
          onChange={setKind}
          options={
            [
              ["http", "HTTP"],
              ["", "全部"],
              ["connection", "历史连接"],
              ["packet", "历史数据包"],
            ] as const
          }
        />
        <span className="spacer" />
        <span className="toolbar-hint traffic-hint">
          <span className="pulse-dot" aria-hidden="true" />
          {rows.length} 条已加载 · 每 2 秒自动刷新
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="data-table-wrap">
          {list === null && !error ? (
            <div className="traffic-loading">
              <Skeleton rows={5} />
            </div>
          ) : filtering ? (
            <EmptyState
              icon={<Search size={20} aria-hidden="true" />}
              title="没有匹配流量"
              desc="调整搜索词或类型筛选；自动刷新只影响新产生的记录。"
            />
          ) : (
            <EmptyState
              icon={<Search size={20} aria-hidden="true" />}
              title="尚无测试流量"
              desc={
                captureDisabled
                  ? "录制代理已在设置中关闭；重新启用后，新执行的 Run 才会继续采集。"
                  : captureOff
                    ? "采集尚未开始：项目运行后，经录制代理的 HTTP / HTTPS 请求会出现在这里。"
                    : paused
                      ? "项目已暂停或结束，采集不会再新增记录。"
                      : "兼容代理环境变量的工具会自动接入；浏览器需显式设置录制代理，未接入的请求不会出现在这里。"
              }
            />
          )}
        </div>
      ) : (
        <div className="data-table-wrap traffic-table-wrap">
          <table className="data-table traffic-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>方法</th>
                <th>目标</th>
                <th>状态</th>
                <th className="num">数据量</th>
                <th className="num">耗时</th>
                <th>任务</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-active={selected === row.id}>
                  <td className="traffic-time">
                    <span className="mono" title={fmt(row.created_at)}>
                      {fmtTime(row.created_at)}
                    </span>
                  </td>
                  <td>
                    <span className="tag">{kindLabels[row.capture_kind] || row.capture_kind}</span>
                  </td>
                  <td className="traffic-method mono">{row.method || "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="traffic-url mono"
                      title={row.url}
                      onClick={() => setSelected(row.id)}
                    >
                      {row.url}
                    </button>
                  </td>
                  <td>
                    {row.error ? (
                      <span className="traffic-bad">失败</span>
                    ) : row.capture_kind === "http" ? (
                      row.status ? (
                        <span className="traffic-code mono" data-tone={statusTone(row.status)}>
                          {row.status}
                        </span>
                      ) : (
                        <span className="muted">请求中</span>
                      )
                    ) : (
                      <span className="quiet">{stateLabel(row)}</span>
                    )}
                  </td>
                  <td className="num mono" title={row.truncated ? "正文被截断" : undefined}>
                    {volumeLabel(row)}
                  </td>
                  <td className="num mono">{row.duration_ms === null ? "—" : `${Math.round(row.duration_ms)} ms`}</td>
                  <td className="mono quiet">{row.step_id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length >= 200 && (
        <div className="traffic-more">
          <button type="button" className="button" disabled={loadingMore} onClick={() => void loadOlder()}>
            <ChevronDown size={14} aria-hidden="true" />
            {loadingMore ? "加载中…" : "加载更早流量"}
          </button>
          <span className="toolbar-hint">更早于 seq {rows[rows.length - 1]?.seq}</span>
        </div>
      )}

      {selected && (
        <Drawer
          label="流量详情"
          title={record ? `${record.method} ${record.host}` : "流量详情"}
          width={record?.capture_kind === "http" ? 1240 : 720}
          className={record?.capture_kind === "http" ? "traffic-inspector-drawer" : undefined}
          onClose={() => {
            setSelected(null);
            setRecord(null);
          }}
        >
          {detailError && (
            <div className="banner danger" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{detailError}</span>
            </div>
          )}

          {!record && !detailError && <Skeleton rows={4} />}

          {record && record.capture_kind === "http" && <TrafficInspector project={id} record={record} />}

          {record && record.capture_kind !== "http" && (
            <>
              <p className="traffic-note">仅记录网络元数据：载荷原样转发，不解析、不解密、不保存。</p>
              {record.error && (
                <div className="banner danger" role="alert">
                  <AlertCircle size={15} aria-hidden="true" />
                  <span>
                    {record.capture_kind === "packet" ? "元数据聚合" : "连接失败"} · {record.error}
                  </span>
                </div>
              )}
              <dl className="meta-list traffic-meta">
                {metadata.map(([label, value]) => (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
              </dl>
              <pre className="traffic-raw" tabIndex={0}>
                {record.request.head}
                {record.response ? `\n${record.response.head}` : ""}
              </pre>
            </>
          )}
        </Drawer>
      )}
    </section>
  );
}
