import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Download,
  FileText,
  RefreshCw,
  Route,
  Search,
  X,
} from "lucide-react";
import type { Evidence } from "../../../../packages/protocol/src/index.js";
import { path } from "../api.js";
import { EmptyState, PageHeader, Skeleton } from "../components/ui.js";
import { scopeForEvidence } from "../graph-scope.js";
import { fmt, fmtBytes, fromNow } from "../format.js";
import { useWorkspace } from "../workspace.js";
import { useViewState } from "../view-state.js";

/** 浏览器里保留的正文上限：更长的内容只给截断提示与下载入口。 */
const MAX_CHARS = 150_000;
/** 超过这个体积不再尝试格式化 JSON，避免在浏览器里再复制一份更大的字符串。 */
const JSON_LIMIT = 200_000;

const mimeLabel = (mime: string) =>
  mime.startsWith("image/")
    ? "图片"
    : mime.includes("json")
      ? "JSON"
      : mime.startsWith("text/")
        ? "文本"
        : "二进制";

const shortMime = (mime: string) => {
  const [, subtype] = mime.split("/");
  return (subtype || mime).replace(/^x-/, "").split(";")[0].slice(0, 18);
};

export function EvidencePage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = ws.id!;
  const preview = ws.evidencePreview;
  const item = preview?.item;
  const [query, setQuery] = useViewState(`${graph.project.id}:evidence:query`, "");
  const [savedId, setSavedId] = useViewState<string | null>(
    `${graph.project.id}:evidence:selected`,
    null,
  );
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pretty, setPretty] = useState(true);
  const generation = useRef(0);

  const select = (next: Evidence) => {
    setSavedId(next.id);
    // 只登记选中项：正文由本页按代次自行拉取，避免同一份内容被请求两次。
    ws.setEvidencePreview({ item: next });
  };

  // 回到本页时恢复上次预览的证据，前提是它仍在归档里。
  useEffect(() => {
    if (ws.evidencePreview || !savedId) return;
    const restored = graph.evidence.find((value) => value.id === savedId);
    if (restored) ws.setEvidencePreview({ item: restored });
    // 只在挂载时执行一次：之后的选中状态由当前交互决定。
  }, []);

  // 从抽屉或其它页面打开的证据同样记到本页的「上次预览」。
  useEffect(() => {
    if (item) setSavedId(item.id);
  }, [item?.id]);

  const itemId = item?.id;
  const mime = item?.mime_type ?? "";
  const isImage = mime.startsWith("image/");

  useEffect(() => {
    setPretty(true);
  }, [itemId]);

  useEffect(() => {
    const token = ++generation.current;
    if (!itemId || isImage) {
      setContent("");
      setTruncated(false);
      setLoadError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError("");
    void (async () => {
      try {
        const response = await fetch(
          "/api" + path(projectId, `/evidence/${encodeURIComponent(itemId)}/content`),
        );
        if (!response.ok) throw new Error(`读取证据内容失败（HTTP ${response.status}）`);
        const raw = await response.text();
        if (token !== generation.current) return;
        setTruncated(raw.length > MAX_CHARS);
        setContent(raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw);
      } catch (failure) {
        if (token !== generation.current) return;
        setTruncated(false);
        setContent("");
        setLoadError(failure instanceof Error ? failure.message : "读取证据内容失败");
      } finally {
        if (token === generation.current) setLoading(false);
      }
    })();
  }, [itemId, isImage, projectId]);

  const needle = query.trim().toLowerCase();
  const stepById = useMemo(
    () => new Map(graph.steps.map((value) => [value.id, value])),
    [graph.steps],
  );
  const archives = useMemo(
    () =>
      [...graph.evidence].sort(
        (left, right) =>
          right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      ),
    [graph.evidence],
  );
  const matched = useMemo(
    () =>
      archives.filter((value) =>
        [value.id, value.title, value.source_path ?? "", value.step_id ?? "", value.mime_type]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      ),
    [archives, needle],
  );

  const parsedJson = useMemo<unknown>(() => {
    if (!content || content.length > JSON_LIMIT) return null;
    const head = content.trimStart();
    if (!head.startsWith("{") && !head.startsWith("[")) return null;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }, [content]);

  const displayText = pretty && parsedJson !== null ? JSON.stringify(parsedJson, null, 2) : content;
  const lines = displayText ? displayText.split("\n").length : 0;
  const contentHref = item
    ? "/api" + path(projectId, `/evidence/${encodeURIComponent(item.id)}/content`)
    : "";
  const scope = item ? scopeForEvidence(graph, item.id) : null;
  const asset = item?.asset_id
    ? graph.assets.find((value) => value.id === item.asset_id)
    : undefined;
  const step = item?.step_id ? stepById.get(item.step_id) : undefined;

  return (
    <section className="page page-evidence">
      <PageHeader
        eyebrow="EVIDENCE / ARCHIVE"
        title="证据"
        description="工具输出、请求响应与文件的只读归档：正文按 SHA-256 固定，摘要只用于探索。"
        actions={
          <>
            <span className="evidence-pill">
              匹配 {matched.length} / 归档 {graph.evidence.length}
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={ws.refreshing || ws.busy}
              onClick={() => void ws.refresh()}
            >
              <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} />
              刷新
            </button>
          </>
        }
      />

      <div className="toolbar evidence-toolbar">
        <label className="search-input evidence-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索证据"
            placeholder="搜索 ID、标题、来源路径、任务或 MIME"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {query && (
          <button type="button" className="button ghost small" onClick={() => setQuery("")}>
            清空
          </button>
        )}
        <span className="toolbar-hint">只读归档 · 原始内容按 SHA-256 固定</span>
      </div>

      {graph.evidence.length ? (
        <div className="evidence-layout">
          <aside className="evidence-index" aria-label="证据索引">
            <header className="evidence-index-head">
              <span>证据索引</span>
              <span className="mono">{matched.length}</span>
            </header>
            <div className="evidence-index-list">
              {matched.map((entry) => {
                const step = entry.step_id ? stepById.get(entry.step_id) : undefined;
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className="evidence-index-item"
                    data-active={item?.id === entry.id}
                    aria-current={item?.id === entry.id ? "true" : undefined}
                    title={entry.source_path || entry.title}
                    onClick={() => select(entry)}
                  >
                    <span className="evidence-item-title">{entry.title}</span>
                    <span className="evidence-item-meta mono">
                      <span className="evidence-item-id">{entry.id}</span>
                      {entry.step_id && (
                        <span title={step ? `任务：${step.description}` : "任务已不在当前图中"}>
                          {entry.step_id}
                        </span>
                      )}
                      <span className="evidence-item-kind">{mimeLabel(entry.mime_type)}</span>
                      <span>{fmtBytes(entry.size)}</span>
                      <time dateTime={entry.created_at}>{fromNow(entry.created_at)}</time>
                    </span>
                  </button>
                );
              })}
              {!matched.length && (
                <p className="evidence-index-empty">没有匹配的证据。清空搜索关键词即可看到全部归档。</p>
              )}
            </div>
          </aside>

          <section className="evidence-viewer" aria-label="证据详情">
            {item ? (
              <>
                <header className="evidence-viewer-head">
                  <div className="evidence-viewer-title">
                    <div className="evidence-ident">
                      <span className="evidence-id mono">{item.id}</span>
                      <span className="evidence-tag">{mimeLabel(item.mime_type)}</span>
                      {item.indexed === false && <span className="evidence-tag">未索引</span>}
                    </div>
                    <h2>{item.title}</h2>
                    <p className="evidence-sub">
                      <span className="mono">{shortMime(item.mime_type)}</span>
                      <span>{fmtBytes(item.size)}</span>
                      <span>{fmt(item.created_at)}</span>
                      {item.step_id && (
                        <span className="mono" title={step ? `任务：${step.description}` : undefined}>
                          任务 {item.step_id}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="evidence-actions">
                    <button
                      type="button"
                      className="button small"
                      disabled={!scope || scope.ids.length === 0}
                      title={
                        scope && scope.ids.length
                          ? `只看引用了这条证据的 ${scope.ids.length} 个观测与结论`
                          : "还没有观测或结论引用这条证据"
                      }
                      onClick={() => {
                        if (scope) ws.openInGraph(scope);
                      }}
                    >
                      <Route size={13} aria-hidden="true" />
                      只看相关链路
                    </button>
                    <a className="button small" href={contentHref} download={item.title}>
                      <Download size={13} aria-hidden="true" />
                      下载原始证据
                    </a>
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => {
                        setSavedId(null);
                        ws.setEvidencePreview(null);
                      }}
                    >
                      <X size={13} aria-hidden="true" />
                      关闭
                    </button>
                  </div>
                </header>

                <dl className="evidence-meta">
                  <div>
                    <dt>证据 ID</dt>
                    <dd className="mono">{item.id}</dd>
                  </div>
                  <div>
                    <dt>MIME</dt>
                    <dd className="mono">{item.mime_type}</dd>
                  </div>
                  <div>
                    <dt>大小</dt>
                    <dd>{fmtBytes(item.size)}</dd>
                  </div>
                  <div>
                    <dt>创建</dt>
                    <dd>{fmt(item.created_at)}</dd>
                  </div>
                  <div>
                    <dt>任务</dt>
                    <dd
                      className="mono"
                      title={step && item.step_id ? `任务：${step.description}` : undefined}
                    >
                      {item.step_id || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>资产</dt>
                    <dd className="mono" title={asset ? `${asset.id} · ${asset.hostname}` : undefined}>
                      {item.asset_id ? `${item.asset_id}${asset ? ` · ${asset.hostname}` : ""}` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>引用</dt>
                    <dd>{scope && scope.ids.length ? `${scope.ids.length} 个节点` : "暂无引用"}</dd>
                  </div>
                  <div>
                    <dt>索引</dt>
                    <dd>{item.indexed === false ? "未索引（二进制）" : "已索引正文"}</dd>
                  </div>
                  <div className="wide">
                    <dt>来源路径</dt>
                    <dd className="mono">{item.source_path || "—"}</dd>
                  </div>
                  <div className="wide">
                    <dt>SHA-256</dt>
                    <dd className="mono evidence-hash">{item.sha256}</dd>
                  </div>
                </dl>

                <section className="evidence-content" aria-label="原始内容">
                  <header className="evidence-content-head">
                    <h3>原始内容</h3>
                    <div className="evidence-content-tools">
                      <span className="mono">
                        {isImage ? fmtBytes(item.size) : `${lines} 行 · ${fmtBytes(item.size)}`}
                      </span>
                      {parsedJson !== null && (
                        <button
                          type="button"
                          className="button subtle small"
                          aria-pressed={pretty}
                          onClick={() => setPretty((value) => !value)}
                        >
                          <Braces size={12} aria-hidden="true" />
                          {pretty ? "显示原始" : "格式化 JSON"}
                        </button>
                      )}
                    </div>
                  </header>

                  {truncated && (
                    <p className="evidence-note">
                      内容超过 {MAX_CHARS.toLocaleString("zh-CN")} 字符，此处已截断；下载原始证据查看完整内容。
                    </p>
                  )}
                  {loadError && (
                    <p className="evidence-error" role="alert">
                      {loadError}
                    </p>
                  )}

                  {isImage ? (
                    <figure className="evidence-figure">
                      <img src={contentHref} alt={item.title} />
                      <figcaption className="mono">
                        {item.title} · {fmtBytes(item.size)}
                      </figcaption>
                    </figure>
                  ) : loading ? (
                    <div className="evidence-loading">
                      <Skeleton rows={6} />
                    </div>
                  ) : (
                    <pre className="evidence-pre">{displayText || "（空内容）"}</pre>
                  )}
                </section>
              </>
            ) : (
              <EmptyState
                icon={<FileText size={20} />}
                title="选择一条证据"
                desc="从左侧索引选一条，查看原始正文、SHA-256 与关联链路入口。证据只读，不会被摘要覆盖。"
              />
            )}
          </section>
        </div>
      ) : (
        <EmptyState
          icon={<FileText size={20} />}
          title="还没有证据"
          desc="先运行 Execute：工具输出、HTTP 请求响应、截图与脚本会按 SHA-256 归档到这里。"
        />
      )}
    </section>
  );
}
