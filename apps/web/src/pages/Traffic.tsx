import { Fragment, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  TrafficRecord,
  TrafficStatus,
  TrafficSummary,
} from "../../../../packages/protocol/src/traffic.js";
import { api, path } from "../api.js";
import { Drawer, EmptyState, PageHeader, Segmented, Skeleton } from "../components/ui.js";
import { fmt, fmtBytes, fmtTime } from "../format.js";
import { useWorkspace } from "../workspace.js";

type TrafficList = { records: TrafficSummary[]; capture: TrafficStatus };
type Kind = "" | "http" | "connection" | "packet";
type MessageMode = "raw" | "body" | "hex";
type BodyPage = { body_base64: string; offset: number; size: number; next: number | null };

const kindLabels: Record<string, string> = { http: "HTTP", connection: "连接", packet: "数据包" };

const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

/** base64 → 字节；损坏的正文返回 null，而不是抛出。 */
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function hexDump(bytes: Uint8Array, offset: number) {
  const lines: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const chunk = Array.from(bytes.slice(index, index + 16), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(" ");
    lines.push(`${(offset + index).toString(16).padStart(6, "0")}  ${chunk}`);
  }
  return lines.join("\n");
}

/** 非 HTTP 记录没有可判定的状态码：连接看生命周期，数据包看聚合数量。 */
function stateLabel(row: TrafficSummary) {
  if (row.error) return "失败";
  if (row.capture_kind === "connection")
    return row.capture_state === "closed" ? "已结束" : "进行中";
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
  if (row.capture_kind === "connection")
    return `↑${fmtBytes(row.request_size)} ↓${fmtBytes(row.response_size)}`;
  if (row.capture_kind === "packet")
    return `${fmtBytes(row.request_size)} · ${row.packet_count || 0} 包`;
  return `${fmtBytes(row.response_size)}${row.truncated ? " *" : ""}`;
}

const decoder = new TextDecoder();

function MessageView({
  project,
  record,
  side,
  mode,
}: {
  project: string;
  record: TrafficRecord;
  side: "request" | "response";
  mode: MessageMode;
}) {
  const message = record[side];
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BodyPage | null>(null);
  const [error, setError] = useState("");
  const url = path(project, `/traffic/${encodeURIComponent(record.id)}/${side}/body`);
  useEffect(() => {
    let stopped = false;
    setPage(null);
    setError("");
    if (!message) return;
    api<BodyPage>(`${url}?offset=${offset}`)
      .then((value) => {
        if (!stopped) setPage(value);
      })
      .catch((failure: unknown) => {
        if (!stopped) setError(messageOf(failure));
      });
    return () => {
      stopped = true;
    };
  }, [url, offset, message]);

  const bytes = page ? decodeBase64(page.body_base64) : null;
  const length = bytes?.length ?? 0;
  const body = !page
    ? error
      ? "预览加载失败"
      : "加载正文…"
    : bytes === null
      ? "正文编码无法解析"
      : bytes.length === 0
        ? "（正文为空）"
        : mode === "hex"
          ? hexDump(bytes, page.offset)
          : decoder.decode(bytes);
  const preview = message
    ? [
        mode === "raw" ? message.head : "",
        body,
        mode === "raw" && message.trailers && page?.next === null ? message.trailers : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n")
    : "";
  const range = page
    ? `预览字节 ${page.size ? page.offset + 1 : 0}–${page.offset + length} / ${page.size}`
    : "加载正文…";

  return (
    <section className="traffic-message" aria-label={side === "request" ? "请求" : "响应"}>
      <header className="traffic-message-head">
        <h3>{side === "request" ? "请求" : "响应"}</h3>
        {message && (
          <span className="traffic-message-meta">
            {message.truncated ? "保存不完整" : "正文完整"} · {fmtBytes(message.size)}
          </span>
        )}
      </header>
      {message ? (
        <>
          <div className="traffic-message-tools">
            <span className="traffic-message-hint">{range}</span>
            <span className="spacer" />
            <a className="button small" href={`/api${url}?download=1`}>
              下载{message.truncated ? "已保存" : "完整"}正文
            </a>
          </div>
          {error && (
            <p className="traffic-bad" role="alert">
              {error}
            </p>
          )}
          <pre className="traffic-pre" tabIndex={0}>
            {preview}
          </pre>
          {page && (
            <div className="traffic-body-nav">
              <button
                type="button"
                className="button small"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 65536))}
              >
                上一页
              </button>
              <button
                type="button"
                className="button small"
                disabled={page.next === null}
                onClick={() => {
                  if (page.next !== null) setOffset(page.next);
                }}
              >
                下一页
              </button>
              <span className="toolbar-hint">每页 64 KiB</span>
            </div>
          )}
        </>
      ) : (
        <p className="traffic-message-empty">{record.error ? "未获得响应" : "等待响应"}</p>
      )}
    </section>
  );
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
  const [mode, setMode] = useState<MessageMode>("raw");
  const generation = useRef(0);
  const selection = useRef(0);

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
    const url = path(
      id,
      `/traffic?limit=200&kind=${kind}&q=${encodeURIComponent(debounced)}`,
    );
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

  const rows = [
    ...new Map(
      [...(list?.records || []), ...older].map((row) => [row.id, row] as const),
    ).values(),
  ].sort((a, b) => b.seq - a.seq);

  async function loadOlder() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    const current = generation.current;
    try {
      const result = await api<TrafficList>(
        path(
          id,
          `/traffic?before=${last.seq}&limit=200&kind=${kind}&q=${encodeURIComponent(debounced)}`,
        ),
      );
      if (current === generation.current) setOlder((existing) => [...existing, ...result.records]);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoadingMore(false);
    }
  }

  const capture = list?.capture;
  const projectStatus = ws.graph?.project.status;
  const paused = projectStatus === "stopped" || projectStatus === "completed";
  const stale =
    !paused &&
    (capture?.state === "active" || capture?.state === "degraded") &&
    !!capture?.last_seen &&
    Date.now() - Date.parse(capture.last_seen) > 45_000;
  const captureLabel = paused
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
  const captureTone = paused
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
  const captureTitle = paused
    ? projectStatus === "completed"
      ? "项目已完成，采集不再新增记录"
      : "项目已暂停，采集不再新增记录"
    : stale
      ? `超过 45 秒未收到心跳（最近 ${fmt(capture?.last_seen)}），记录可能缺失`
      : capture?.last_seen
        ? `最近心跳 ${fmt(capture.last_seen)}`
        : "尚未收到采集状态上报";

  const filtering = debounced.trim() !== "" || (kind !== "" && kind !== "http");
  const captureOff = !paused && (capture?.state === "stopped" || capture?.state === "unavailable");

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
              <dd>
                仅录制通过录制代理、且识别为 HTTP / HTTPS 的流量；支持任意目标端口，不根据 80 / 443
                判断协议。
              </dd>
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
                HTTPS 使用受信任的项目 CA 解密；证书固定、双向 TLS
                等不兼容连接请使用原连接方式，系统不自动重试请求。
              </dd>
            </div>
            <div>
              <dt>保存</dt>
              <dd>
                请求与响应正文完整保存，页面分页预览并支持完整下载；不按条数或累计大小自动删除历史。
              </dd>
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
                captureOff
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
                  <td className="num mono">
                    {row.duration_ms === null ? "—" : `${Math.round(row.duration_ms)} ms`}
                  </td>
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
          width={720}
          onClose={() => {
            setSelected(null);
            setRecord(null);
          }}
        >
          <div className="traffic-insp-bar">
            <span className="traffic-insp-meta mono">
              {record ? fmt(record.created_at) : "读取中…"}
            </span>
            <span className="spacer" />
            {record?.capture_kind === "http" && (
              <Segmented<MessageMode>
                ariaLabel="报文展示"
                size="sm"
                value={mode}
                onChange={setMode}
                options={
                  [
                    ["raw", "原始报文"],
                    ["body", "正文"],
                    ["hex", "十六进制"],
                  ] as const
                }
              />
            )}
          </div>

          {detailError && (
            <div className="banner danger" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{detailError}</span>
            </div>
          )}

          {!record && !detailError && <Skeleton rows={4} />}

          {record && record.capture_kind === "http" && (
            <>
              <div className="traffic-insp-sub">
                {record.run_id ? (
                  <span className="mono">{record.run_id}</span>
                ) : (
                  <span>未关联运行</span>
                )}
                {record.step_id && <span className="mono">· {record.step_id}</span>}
                {record.error && <span className="traffic-bad">· {record.error}</span>}
              </div>
              <div className="traffic-messages">
                {(["request", "response"] as const).map((side) => (
                  <MessageView
                    key={`${record.id}-${side}`}
                    project={id}
                    record={record}
                    side={side}
                    mode={mode}
                  />
                ))}
              </div>
            </>
          )}

          {record && record.capture_kind !== "http" && (
            <>
              <p className="traffic-note">
                仅记录网络元数据：载荷原样转发，不解析、不解密、不保存。
              </p>
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
