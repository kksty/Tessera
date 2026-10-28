import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy, Download, Loader2, Pencil, RotateCcw, Send, WrapText, X } from "lucide-react";
import type { TrafficRecord, TrafficResendResult } from "../../../../packages/protocol/src/traffic.js";
import { api, path } from "../api.js";
import { fmt, fmtBytes } from "../format.js";
import { Drawer, Segmented, Skeleton } from "./ui.js";

type Mode = "render" | "raw" | "body" | "hex";
type Layout = "split" | "request" | "response";
type BodyPage = { body_base64: string; offset: number; size: number; next: number | null };
type BodyState = { bytes: Uint8Array; size: number; truncated: boolean; error?: string };
type ResendView = {
  result: TrafficResendResult;
  bytes: Uint8Array;
  busy: boolean;
  onRestore: () => void;
};
type RequestEditor = { value: string; onChange: (value: string) => void };

/** Render at most 512 KiB in the inspector; the download button still returns the full body. */
const MAX_BODY = 512 * 1024;
/** Request editing is limited so the browser text area and JSON body stay responsive. */
const MAX_EDIT_BODY = 8 * 1024 * 1024;
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function hexDump(bytes: Uint8Array, offset: number) {
  const lines: string[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const chunk = Array.from(bytes.slice(index, index + 16), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${(offset + index).toString(16).padStart(6, "0")}  ${chunk}`);
  }
  return lines.join("\n");
}

function statusTone(status: number) {
  if (status >= 500) return "danger";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "success";
}

function headerValue(head: string, name: string) {
  const wanted = name.toLowerCase();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) return line.slice(colon + 1).trim();
  }
  return "";
}
async function loadBody(
  project: string,
  record: TrafficRecord,
  side: "request" | "response",
  limit = MAX_BODY,
): Promise<BodyState> {
  const message = record[side];
  if (!message) throw new Error("没有可加载的正文");
  const url = path(project, `/traffic/${encodeURIComponent(record.id)}/${side}/body`);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  let size = message.size;
  let truncated = false;
  for (;;) {
    const page = await api<BodyPage>(`${url}?offset=${offset}`);
    const bytes = decodeBase64(page.body_base64);
    if (!bytes) throw new Error("正文编码无法解析");
    chunks.push(bytes);
    total += bytes.length;
    size = page.size;
    if (page.next === null || total >= limit) {
      truncated = page.next !== null;
      break;
    }
    offset = page.next;
  }
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return { bytes: merged, size, truncated };
}

function useBody(
  project: string,
  record: TrafficRecord,
  side: "request" | "response",
  enabled = true,
): BodyState | null {
  const message = record[side];
  const [state, setState] = useState<BodyState | null>(null);
  // Live flows are re-fetched every two seconds and produce a fresh message object
  // each time. Depend on the stable body identity instead, otherwise the pane
  // blanks and re-downloads its pages on every poll.
  const head = message?.head;
  const size = message?.size;
  useEffect(() => {
    let stopped = false;
    setState(null);
    if (!enabled || head === undefined) return;
    void loadBody(project, record, side)
      .then((value) => {
        if (!stopped) setState(value);
      })
      .catch((failure: unknown) => {
        if (!stopped)
          setState({ bytes: new Uint8Array(), size: size ?? 0, truncated: false, error: messageOf(failure) });
      });
    return () => {
      stopped = true;
    };
  }, [enabled, project, record.id, side, head, size]);
  return state;
}

/** Pretty-print JSON/form bodies; unknown content stays byte-for-byte. */
function presentBody(raw: string, contentType: string) {
  const trimmed = raw.trim();
  const jsonish = /json/i.test(contentType) || /^[\[{]/.test(trimmed);
  if (jsonish && trimmed.length < 2_000_000) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
    } catch {
      /* Not valid JSON after all; fall through to raw text. */
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType) && trimmed) {
    try {
      return {
        text: trimmed
          .split("&")
          .map((part) => {
            const equal = part.indexOf("=");
            return equal < 0
              ? decodeURIComponent(part)
              : `${decodeURIComponent(part.slice(0, equal))} = ${decodeURIComponent(part.slice(equal + 1))}`;
          })
          .join("\n"),
        json: false,
      };
    } catch {
      /* Malformed escapes: show the original. */
    }
  }
  return { text: raw, json: false };
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function JsonText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  JSON_TOKEN.lastIndex = 0;
  while ((match = JSON_TOKEN.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match[1]) {
      if (match[2]) {
        nodes.push(
          <span className="json-key" key={`k${index++}`}>
            {match[1]}
          </span>,
          match[2],
        );
      } else {
        nodes.push(
          <span className="json-string" key={`k${index++}`}>
            {match[1]}
          </span>,
        );
      }
    } else if (/^(true|false|null)$/.test(match[0])) {
      nodes.push(
        <span className="json-atom" key={`k${index++}`}>
          {match[0]}
        </span>,
      );
    } else {
      nodes.push(
        <span className="json-number" key={`k${index++}`}>
          {match[0]}
        </span>,
      );
    }
    cursor = JSON_TOKEN.lastIndex;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function firstLine(line: string, side: "request" | "response") {
  if (side === "request") {
    const match = /^(\S+)\s+(\S+)\s+(HTTP\/[\d.]+)$/.exec(line);
    if (match)
      return (
        <>
          <span className="http-method" data-method={match[1].toUpperCase()}>
            {match[1]}
          </span>{" "}
          <span className="http-target">{match[2]}</span> <span className="http-version">{match[3]}</span>
        </>
      );
  } else {
    const match = /^(HTTP\/[\d.]+)\s+(\d{3})\s*(.*)$/.exec(line);
    if (match)
      return (
        <>
          <span className="http-version">{match[1]}</span>{" "}
          <span className="http-status" data-tone={statusTone(Number(match[2]))}>
            {match[2]}
          </span>{" "}
          <span className="http-reason">{match[3]}</span>
        </>
      );
  }
  return <>{line}</>;
}

function HttpHead({ head, side }: { head: string; side: "request" | "response" }) {
  const lines = head.split(/\r?\n/);
  const start = lines.shift() || "";
  const headers = lines.filter((line) => line !== "");
  return (
    <div className="http-head">
      <div className="http-line http-start">{firstLine(start, side)}</div>
      {headers.map((line, index) => {
        const colon = line.indexOf(":");
        if (colon <= 0)
          return (
            <div className="http-line" key={index}>
              {line}
            </div>
          );
        return (
          <div className="http-line" key={index}>
            <span className="http-header-name">{line.slice(0, colon)}</span>
            <span className="http-colon">:</span>
            <span className="http-header-value">{line.slice(colon + 1)}</span>
          </div>
        );
      })}
    </div>
  );
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (text: string) => {
    await writeClipboard(text);
    setCopied(true);
  };
  return { copied, copy };
}

function MessagePane({
  project,
  record,
  side,
  mode,
  wrap,
  resend,
  editor,
}: {
  project: string;
  record: TrafficRecord;
  side: "request" | "response";
  mode: Mode;
  wrap: boolean;
  resend?: ResendView;
  editor?: RequestEditor;
}) {
  const resent = resend?.result;
  const message = resent
    ? { head: resent.response_head || "", size: resent.body_size, truncated: resent.truncated }
    : record[side];
  const loaded = useBody(project, record, side, !resent && !editor);
  const state: BodyState | null = resent
    ? {
        bytes: resend?.bytes || new Uint8Array(),
        size: resent.body_size,
        truncated: resent.truncated,
        ...(resent.error ? { error: resent.error } : {}),
      }
    : loaded;
  const contentType = message ? headerValue(message.head, "content-type") : "";
  const binary = useMemo(() => {
    if (!state || !state.bytes.length) return false;
    if (/^(image|audio|video|font)\//i.test(contentType)) return true;
    if (/application\/(octet-stream|pdf|zip|gzip)/i.test(contentType)) return true;
    for (let index = 0; index < Math.min(state.bytes.length, 4096); index += 1)
      if (state.bytes[index] === 0) return true;
    return false;
  }, [contentType, state]);
  const rawText = useMemo(() => (state ? decoder.decode(state.bytes) : ""), [state]);
  const body = useMemo(() => presentBody(rawText, contentType), [contentType, rawText]);
  const { copied, copy } = useCopy();
  const download =
    !resent && message
      ? `/api${path(project, `/traffic/${encodeURIComponent(record.id)}/${side}/body`)}?download=1`
      : "";
  // Trailers are part of the wire bytes; only show them when the whole body is loaded.
  const trailers = !resent && !state?.truncated ? (record[side]?.trailers ?? "") : "";
  const raw = message ? [message.head, rawText, trailers].filter((part) => part !== "").join("\n\n") : "";
  const copyTitle = !state
    ? "正文加载中"
    : state.error
      ? "复制已加载报文"
      : state.truncated
        ? resent
          ? "复制已加载报文（仅显示前 2 MiB）"
          : "复制已加载报文（完整正文请下载）"
        : "复制完整报文";

  const bodyNode = () => {
    if (!state) {
      return (
        <div className="http-body-state">
          <span className="http-loading-dot" aria-hidden="true" />
          加载正文…
        </div>
      );
    }
    if (state.error && !resent) {
      return (
        <div className="http-body-state bad">
          <AlertCircle size={14} aria-hidden="true" />
          {state.error}
        </div>
      );
    }
    if (resent && !message?.head) {
      return <div className="http-body-state">{resent.error ? "没有收到响应" : "等待响应"}</div>;
    }
    if (mode === "hex") {
      return (
        <pre className={`http-body ${wrap ? "wrap" : ""}`} tabIndex={0}>
          {state.bytes.length ? hexDump(state.bytes, 0) : "（正文为空）"}
        </pre>
      );
    }
    if (binary) {
      return (
        <div className="http-body-state">
          二进制正文（{fmtBytes(state.size)}）。切换到「十六进制」查看
          {resent ? "。" : "，或下载完整正文。"}
        </div>
      );
    }
    if (!state.bytes.length) return <div className="http-body-state">（正文为空）</div>;
    return (
      <pre className={`http-body ${wrap ? "wrap" : ""}`} tabIndex={0}>
        {body.json ? <JsonText text={body.text} /> : body.text}
      </pre>
    );
  };

  return (
    <section
      className="http-pane"
      data-side={side}
      data-resend={resent ? "true" : undefined}
      data-editing={editor ? "true" : undefined}
      aria-label={side === "request" ? "请求报文" : "响应报文"}
    >
      <header className="http-pane-head">
        <span className="http-pane-kicker">
          <i aria-hidden="true" />
          {side === "request" ? "请求" : "响应"}
        </span>
        {editor && (
          <span className="traffic-resend-tag" title="编辑内容只用于本次重发，不写入流量列表，也不归档正文">
            编辑中
          </span>
        )}
        {resent && (
          <span className="traffic-resend-tag" title="重发结果仅用于当前查看，不写入流量列表，也不归档正文">
            重发 · 临时
          </span>
        )}
        {resent &&
          (resent.status ? (
            <span className="traffic-code mono" data-tone={statusTone(resent.status)}>
              {resent.status}
            </span>
          ) : (
            <span className="traffic-bad">失败</span>
          ))}
        {editor ? (
          <span className="http-pane-meta">原始 {fmtBytes(message?.size || 0)} · 不归档</span>
        ) : resent ? (
          <span className="http-pane-meta">
            {resent.duration_ms} ms · {fmtBytes(resent.body_size)}
            {resent.truncated ? " · 仅显示前 2 MiB" : ""}
          </span>
        ) : message ? (
          <span className="http-pane-meta">
            {fmtBytes(message.size)}
            {message.truncated ? " · 保存不完整" : ""}
            {state?.truncated ? ` · 预览前 ${fmtBytes(MAX_BODY)}` : ""}
          </span>
        ) : (
          <span className="http-pane-meta">{record.error ? "未获得响应" : "等待响应"}</span>
        )}
        <span className="spacer" />
        {resent && resend && (
          <button
            type="button"
            className="button small ghost http-pane-restore"
            title="还原为原始捕获的请求与响应"
            disabled={resend.busy}
            onClick={resend.onRestore}
          >
            <RotateCcw size={13} aria-hidden="true" />
            还原
          </button>
        )}
        {message && !editor && (
          <>
            <button
              type="button"
              className="icon-button http-pane-tool"
              aria-label={`复制${side === "request" ? "请求" : "响应"}报文`}
              title={copyTitle}
              disabled={!state || (!resent && !!state.error)}
              onClick={() => void copy(raw)}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {!resent && (
              <a className="icon-button http-pane-tool" href={download} aria-label="下载完整正文" title="下载完整正文">
                <Download size={14} />
              </a>
            )}
          </>
        )}
      </header>
      {editor ? (
        <div className="http-pane-body" data-mode="edit">
          <div className="http-request-editor-wrap">
            <textarea
              className={`http-request-editor ${wrap ? "wrap" : ""}`}
              value={editor.value}
              onChange={(event) => editor.onChange(event.target.value)}
              spellCheck={false}
              autoFocus
              wrap={wrap ? "soft" : "off"}
              aria-label="编辑请求报文"
            />
            <p className="http-request-editor-hint">
              目标主机与端口保持原始记录；发送时自动重算 Content-Length。编辑内容只用于当前查看，不归档。
            </p>
          </div>
        </div>
      ) : message ? (
        <div className="http-pane-body" data-mode={mode} data-wrap={wrap ? "true" : undefined}>
          {resent?.error && (
            <p className="traffic-bad http-resend-bad" role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              {resent.error}
            </p>
          )}
          {mode === "render" && message.head && (
            <>
              <HttpHead head={message.head} side={side} />
              <div className="http-head-rule" aria-hidden="true" />
            </>
          )}
          {mode === "raw" ? (
            <pre className={`http-body ${wrap ? "wrap" : ""}`} tabIndex={0}>
              {message.head ? `${message.head}\n\n` : ""}
              {resent && !message.head
                ? resent.error || "没有收到响应"
                : state?.error
                  ? `（正文加载失败：${state.error}）`
                  : state
                    ? binary
                      ? "（二进制正文）"
                      : rawText
                    : "加载正文…"}
              {trailers && state && !state.error && !binary ? `\n\n${trailers}` : ""}
            </pre>
          ) : (
            bodyNode()
          )}
        </div>
      ) : (
        <div className="http-pane-empty">{record.error ? "未获得响应" : "等待响应"}</div>
      )}
    </section>
  );
}

export function TrafficInspector({ project, record }: { project: string; record: TrafficRecord }) {
  const [mode, setMode] = useState<Mode>("render");
  const [layout, setLayout] = useState<Layout>("split");
  // 打开即自动换行，长 URL / JSON / 表单更易读；仍可手动关闭。
  const [wrap, setWrap] = useState(true);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState("");
  const [resendResult, setResendResult] = useState<TrafficResendResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  // 每条报文独立的复制/下载按钮已足够；不再提供「复制全部」。
  const resendBytes = useMemo(
    () => (resendResult ? decodeBase64(resendResult.body_base64) || new Uint8Array() : null),
    [resendResult],
  );
  const recordId = useRef(record.id);

  const restoreTransient = () => {
    setResendResult(null);
    setResendError("");
    if (editing) {
      setEditing(false);
      setDraft("");
      setEditError("");
    }
  };
  const resendView: ResendView | undefined =
    resendResult && resendBytes
      ? { result: resendResult, bytes: resendBytes, busy: resending, onRestore: restoreTransient }
      : undefined;

  // A transient resend or draft belongs to one captured flow. Selecting another
  // flow must never leave the previous request or response on screen.
  useEffect(() => {
    recordId.current = record.id;
    setResendResult(null);
    setResendError("");
    setResending(false);
    setEditing(false);
    setDraft("");
    setEditLoading(false);
    setEditError("");
  }, [record.id]);

  const editBlocked = record.request.truncated
    ? "请求正文保存不完整，不能编辑"
    : record.request.size > MAX_EDIT_BODY
      ? `请求正文超过 ${fmtBytes(MAX_EDIT_BODY)}，不能在线编辑`
      : "";

  async function beginEdit() {
    if (editing || editLoading || resending) return;
    if (editBlocked) {
      setEditError(editBlocked);
      return;
    }
    const flowId = record.id;
    setEditLoading(true);
    setEditError("");
    setResendError("");
    setLayout((value) => (value === "response" ? "split" : value));
    try {
      const body = await loadBody(project, record, "request", MAX_EDIT_BODY);
      if (recordId.current !== flowId) return;
      if (body.truncated || body.bytes.length > MAX_EDIT_BODY)
        throw new Error(`请求正文超过 ${fmtBytes(MAX_EDIT_BODY)}，不能在线编辑`);
      const contentType = headerValue(record.request.head, "content-type");
      if (
        /^(image|audio|video|font)\//i.test(contentType) ||
        /application\/(octet-stream|pdf|zip|gzip)/i.test(contentType)
      )
        throw new Error("请求正文是二进制内容，不能在线编辑");
      if (body.bytes.includes(0)) throw new Error("请求正文包含空字节，不能在线编辑");
      let bodyText = "";
      try {
        bodyText = strictDecoder.decode(body.bytes);
      } catch {
        throw new Error("请求正文不是 UTF-8 文本，不能在线编辑");
      }
      const head = record.request.head.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
      setDraft(`${head}\n\n${bodyText}`);
      setMode("raw");
      setEditing(true);
    } catch (failure) {
      if (recordId.current === flowId) setEditError(messageOf(failure));
    } finally {
      if (recordId.current === flowId) setEditLoading(false);
    }
  }

  function changeDraft(value: string) {
    setDraft(value);
    setResendError("");
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
    setEditError("");
    setResendError("");
    setResendResult(null);
  }

  async function resend(raw?: string) {
    if (resending) return;
    const flowId = record.id;
    setResending(true);
    setResendError("");
    try {
      const result = await api<TrafficResendResult>(
        path(project, `/traffic/${encodeURIComponent(flowId)}/resend`),
        raw === undefined ? {} : { request: raw },
        "POST",
      );
      if (recordId.current !== flowId) return;
      setResendResult(result);
      // Keep the new response visible even if the operator was looking at the request only.
      setLayout((value) => (value === "request" ? "split" : value));
    } catch (failure) {
      if (recordId.current === flowId) setResendError(messageOf(failure));
    } finally {
      if (recordId.current === flowId) setResending(false);
    }
  }

  return (
    <div className="http-inspector">
      <header className="http-summary">
        <div className="http-summary-top">
          <span className="http-method" data-method={record.method.toUpperCase()}>
            {record.method}
          </span>
          <span className="http-url" title={record.url}>
            {record.url}
          </span>
          {(resendResult || editing) && (
            <span
              className="http-record-tag"
              title="顶部状态与耗时来自原始捕获记录；下方报文可能包含未归档的编辑或重发结果"
            >
              原始记录
            </span>
          )}
          {record.status ? (
            <span className="traffic-code mono" data-tone={statusTone(record.status)}>
              {record.status}
            </span>
          ) : (
            <span className="traffic-code mono">{record.error ? "失败" : "请求中"}</span>
          )}
        </div>
        <dl className="http-facts">
          <div>
            <dt>时间</dt>
            <dd>{fmt(record.created_at)}</dd>
          </div>
          <div>
            <dt>协议</dt>
            <dd className="mono">{record.protocol}</dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd className="mono">{record.duration_ms === null ? "—" : `${Math.round(record.duration_ms)} ms`}</dd>
          </div>
          <div>
            <dt>上下行</dt>
            <dd className="mono">
              ↑{fmtBytes(record.request.size)} ↓{fmtBytes(record.response?.size || 0)}
            </dd>
          </div>
          <div>
            <dt>任务</dt>
            <dd className="mono">
              {record.run_id || "未关联运行"}
              {record.step_id ? ` · ${record.step_id}` : ""}
            </dd>
          </div>
        </dl>
        {record.error && (
          <p className="traffic-bad">
            <AlertCircle size={13} aria-hidden="true" /> {record.error}
          </p>
        )}
      </header>

      <div className="http-toolbar">
        <Segmented<Mode>
          ariaLabel="报文展示"
          size="sm"
          value={mode}
          onChange={setMode}
          options={
            [
              ["render", "报文"],
              ["raw", "原文"],
              ["body", "正文"],
              ["hex", "十六进制"],
            ] as const
          }
        />
        <span className="spacer" />
        <Segmented<Layout>
          ariaLabel="分栏"
          size="sm"
          value={layout}
          onChange={setLayout}
          options={
            [
              ["split", "左右分栏"],
              ["request", "只看请求"],
              ["response", "只看响应"],
            ] as const
          }
        />
        <button
          type="button"
          className="button small ghost"
          aria-pressed={wrap}
          title="自动换行"
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText size={14} aria-hidden="true" />
          换行
        </button>
        <button
          type="button"
          className="button small ghost"
          aria-pressed={editing}
          title={editing ? "放弃修改并还原原始请求与响应" : editBlocked || "编辑请求包；目标主机和端口保持原始记录"}
          disabled={editLoading || resending || (!editing && !!editBlocked)}
          onClick={() => {
            if (editing) cancelEdit();
            else void beginEdit();
          }}
        >
          {editLoading ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : editing ? (
            <X size={14} aria-hidden="true" />
          ) : (
            <Pencil size={14} aria-hidden="true" />
          )}
          {editLoading ? "载入中…" : editing ? "取消" : "编辑"}
        </button>
        <button
          type="button"
          className="button small"
          title={editing ? "发送编辑后的请求（结果不归档）" : "立即向目标真实重发这条请求（结果不归档）"}
          disabled={resending || editLoading || (editing && !draft.trim())}
          onClick={() => void resend(editing ? draft : undefined)}
        >
          {resending ? (
            <Loader2 size={14} className="spin" aria-hidden="true" />
          ) : (
            <Send size={14} aria-hidden="true" />
          )}
          {resending ? (editing ? "发送中…" : "重发中…") : editing ? "发送" : "重发"}
        </button>
      </div>

      {editError && (
        <p className="traffic-resend-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          无法编辑：{editError}
        </p>
      )}

      {resendError && (
        <p className="traffic-resend-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {editing ? "发送失败" : "重发失败"}：{resendError}
        </p>
      )}

      <div className="http-panes" data-layout={layout}>
        {(["request", "response"] as const).map((side) => (
          <Fragment key={side}>
            <MessagePane
              project={project}
              record={record}
              side={side}
              mode={mode}
              wrap={wrap}
              resend={side === "response" ? resendView : undefined}
              editor={side === "request" && editing ? { value: draft, onChange: changeDraft } : undefined}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * 就地预览一条真实流量：以大号抽屉覆盖在当前页上方，不切页、不改路由。
 * 关闭后底层页面（发现详情、滚动位置、选中项）保持原样。
 */
export function TrafficPreviewModal({
  project,
  flowId,
  label,
  onClose,
}: {
  project: string;
  flowId: string;
  label?: string;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<TrafficRecord | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let stopped = false;
    setRecord(null);
    setError("");
    api<TrafficRecord>(path(project, `/traffic/${encodeURIComponent(flowId)}`))
      .then((value) => {
        if (!stopped) setRecord(value);
      })
      .catch((failure: unknown) => {
        if (!stopped) setError(messageOf(failure));
      });
    return () => {
      stopped = true;
    };
  }, [project, flowId, retry]);

  const http = record?.capture_kind === "http";
  return (
    <Drawer
      label="真实流量预览"
      title={
        <span className="traffic-preview-title">
          {record ? (
            <>
              <span className="http-method" data-method={record.method.toUpperCase()}>
                {record.method}
              </span>
              <span className="mono">{record.url}</span>
            </>
          ) : (
            <>流量预览{label ? <span className="quiet"> · {label}</span> : null}</>
          )}
        </span>
      }
      width={http ? 1240 : 720}
      className={http ? "traffic-inspector-drawer" : undefined}
      onClose={onClose}
    >
      {error && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="button ghost small" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {!record && !error && <Skeleton rows={5} />}
      {record && record.capture_kind === "http" && <TrafficInspector project={project} record={record} />}
      {record && record.capture_kind !== "http" && (
        <div className="traffic-preview-nonhttp">
          <p className="traffic-note">仅记录网络元数据：载荷原样转发，不解析、不解密、不保存。</p>
          {record.error && (
            <div className="banner danger" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>
                {record.capture_kind === "packet" ? "元数据聚合" : "连接失败"} · {record.error}
              </span>
            </div>
          )}
          <pre className="traffic-raw" tabIndex={0}>
            {record.request.head}
            {record.response ? `\n${record.response.head}` : ""}
          </pre>
        </div>
      )}
    </Drawer>
  );
}
