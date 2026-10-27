import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Braces,
  ChevronRight,
  Download,
  FileArchive,
  FileCode,
  FileImage,
  FileQuestion,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  HardDrive,
  Link2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api, path } from "../api.js";
import { EmptyState, Kpi, Modal, PageHeader, Skeleton } from "../components/ui.js";
import { RichText } from "../components/RichText.js";
import { fmt, fmtBytes } from "../format.js";
import { useViewState } from "../view-state.js";
import { useWorkspace } from "../workspace.js";

type EntryKind = "file" | "directory" | "symlink";

type FileEntry = {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modified_at: string;
};

/** GET /workspace 的原样返回：files + truncated；stats 覆盖当前目录的整个子树，truncated 表示统计达到预算。 */
type ListingStats = { files: number; directories: number; size: number; truncated?: boolean };
type Listing = { path: string; files: FileEntry[]; truncated?: boolean; stats?: ListingStats };
/** GET /workspace/content?preview=1 的原样返回：content 为 base64。 */
type ContentPayload = { path: string; content: string; size: number; truncated?: boolean };

const PREVIEW_LIMIT_LABEL = "128 KiB";

const extensionOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

const CODE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "rb",
  "go",
  "rs",
  "java",
  "php",
  "lua",
  "sql",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "xml",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "html", "css", "scss", "md", "markdown"]);

const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);

function fileVisual(entry: Pick<FileEntry, "name" | "kind">) {
  if (entry.kind === "directory") return { icon: <Folder size={16} />, tone: "folder", label: "文件夹" };
  if (entry.kind === "symlink") return { icon: <Link2 size={16} />, tone: "symlink", label: "符号链接" };
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) return { icon: <FileImage size={16} />, tone: "image", label: "图片" };
  if (ARCHIVE_EXTENSIONS.has(extension)) return { icon: <FileArchive size={16} />, tone: "archive", label: "归档" };
  if (extension === "json" || extension === "ndjson")
    return { icon: <Braces size={16} />, tone: "data", label: "数据" };
  if (isMarkdown(entry.name)) return { icon: <FileText size={16} />, tone: "markdown", label: "Markdown" };
  if (CODE_EXTENSIONS.has(extension)) return { icon: <FileCode size={16} />, tone: "code", label: "代码" };
  if (TEXT_EXTENSIONS.has(extension)) return { icon: <FileText size={16} />, tone: "text", label: "文本" };
  return { icon: <FileQuestion size={16} />, tone: "binary", label: "文件" };
}

/** 二进制嗅探：出现 NUL 或控制字符比例偏高时不尝试按文本展示。 */
function looksBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 4096);
  let controls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const byte = sample[index];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.02;
}

function decodeBase64(source: string) {
  const raw = atob(source);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (looksBinary(bytes)) return { text: "", binary: true };
  return { text: new TextDecoder("utf-8").decode(bytes), binary: false };
}

type PreviewState =
  | { status: "loading"; path: string }
  | {
      status: "ready";
      path: string;
      text: string;
      binary: boolean;
      truncated: boolean;
    }
  | { status: "error"; path: string; message: string };

export function FilesPage() {
  const ws = useWorkspace();
  const project = ws.graph!.project;
  const projectId = project.id;
  const running = project.status === "active";

  const [folder, setFolder] = useViewState(`${projectId}:files:folder`, ".");
  const [selectedPath, setSelectedPath] = useViewState<string | null>(`${projectId}:files:selected`, null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [remove, setRemove] = useState<FileEntry | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError("");
    setListing(null);
    void api<Listing>(path(projectId, `/workspace?path=${encodeURIComponent(folder)}`))
      .then((data) => {
        if (active) setListing(data);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setListError(failure instanceof Error ? failure.message : "读取工作区失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, folder, revision]);

  const files = listing?.files ?? [];
  const selected = useMemo(() => files.find((entry) => entry.path === selectedPath) ?? null, [files, selectedPath]);

  // 预览状态带上所属路径：切换文件时不会先闪出上一个文件的内容。
  useEffect(() => {
    if (!selected || selected.kind !== "file") {
      setPreview(null);
      return;
    }
    let active = true;
    setPreview({ status: "loading", path: selected.path });
    void api<ContentPayload>(path(projectId, `/workspace/content?preview=1&path=${encodeURIComponent(selected.path)}`))
      .then((data) => {
        if (!active) return;
        const decoded = decodeBase64(data.content);
        setPreview({
          status: "ready",
          path: selected.path,
          text: decoded.text,
          binary: decoded.binary,
          truncated: !!data.truncated,
        });
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setPreview({
          status: "error",
          path: selected.path,
          message: failure instanceof Error ? failure.message : "读取文件失败",
        });
      });
    return () => {
      active = false;
    };
  }, [projectId, selected?.path, selected?.kind, revision]);

  const segments = folder === "." ? [] : folder.split("/");
  const currentPath = folder === "." ? "/workspace" : `/workspace/${folder}`;
  const currentFiles = files.filter((entry) => entry.kind !== "directory").length;
  const currentFolders = files.filter((entry) => entry.kind === "directory").length;
  const currentSize = files.reduce((sum, entry) => sum + (entry.kind === "directory" ? 0 : entry.size), 0);
  // Stats cover the whole subtree; fall back to the visible rows for older servers.
  const fileTotal = listing?.stats?.files ?? currentFiles;
  const folderTotal = listing?.stats?.directories ?? currentFolders;
  const totalSize = listing?.stats?.size ?? currentSize;
  const truncated = !!listing?.truncated;
  const statsPartial = !!listing?.stats?.truncated;
  const statsNote = statsPartial ? "（已达统计上限）" : "";
  const previewOpen = !!selected;
  const selectedVisual = selected ? fileVisual(selected) : null;
  const state = preview && selected && preview.path === selected.path ? preview : null;

  const openFolder = (target: string) => {
    setFolder(target);
    setSelectedPath(null);
  };

  const refresh = () => setRevision((value) => value + 1);

  const closeRemove = () => {
    setRemove(null);
    setConfirmed(false);
  };

  const submitRemove = () => {
    if (!remove) return;
    const target = remove.path;
    void ws
      .action(() => api(path(projectId, "/workspace"), { path: target }, "DELETE"))
      .then((ok) => {
        if (!ok) return;
        if (selectedPath === target || selectedPath?.startsWith(`${target}/`)) {
          setSelectedPath(null);
        }
        ws.setMessage("已删除");
        closeRemove();
        refresh();
      });
  };

  return (
    <section className="page page-files">
      <PageHeader
        eyebrow="PROJECT / WORKSPACE"
        title="项目文件"
        description="项目容器内共享的持久卷，只读预览与删除；工具输出、进程日志和临时文件都在这里，只有被黑板引用的原件进入证据页。"
        actions={
          <>
            {running && (
              <span className="status-pill files-run-pill" data-tone="warn">
                <i aria-hidden="true" />
                项目运行中 · 删除需谨慎
              </span>
            )}
            <button type="button" className="button" disabled={loading} onClick={refresh} title="重新读取当前目录">
              <RefreshCw size={14} className={loading ? "spin" : undefined} />
              刷新
            </button>
          </>
        }
      />

      <div className="kpi-grid">
        <Kpi
          label="文件"
          value={fileTotal}
          note={listing?.stats ? `当前目录 ${currentFiles} 个 · 含子目录${statsNote}` : "当前目录"}
          icon={<FileText size={15} />}
        />
        <Kpi
          label="文件夹"
          value={folderTotal}
          note={listing?.stats ? `当前目录 ${currentFolders} 个 · 含子目录${statsNote}` : "当前目录"}
          icon={<FolderOpen size={15} />}
        />
        <Kpi
          label="占用"
          value={fmtBytes(totalSize)}
          note={listing?.stats ? `含子目录总大小${statsNote}` : "当前目录可见文件"}
          icon={<HardDrive size={15} />}
        />
        <Kpi
          label="当前路径"
          value={<span className="files-kpi-path">{currentPath}</span>}
          note={truncated ? "仅索引前 5000 项" : "点面包屑返回上级"}
          icon={<FolderTree size={15} />}
        />
      </div>

      <div className="toolbar files-toolbar">
        <nav className="files-crumbs" aria-label="工作区路径">
          <button
            type="button"
            onClick={() => openFolder(".")}
            aria-current={segments.length ? undefined : "page"}
            title="/workspace"
          >
            <Folder size={13} aria-hidden="true" />
            /workspace
          </button>
          {segments.map((segment, index) => {
            const target = segments.slice(0, index + 1).join("/");
            const last = index === segments.length - 1;
            return (
              <span className="files-crumb" key={target}>
                <ChevronRight size={13} className="files-crumb-sep" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => openFolder(target)}
                  aria-current={last ? "page" : undefined}
                  title={`/workspace/${target}`}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
        <span className="spacer" />
        <span className="toolbar-hint">{files.length} 项 · 刷新以读取最新写入</span>
      </div>

      {listError && (
        <div className="banner danger" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{listError}</span>
          <button type="button" className="button small" onClick={refresh}>
            重试
          </button>
        </div>
      )}

      <div className={`files-layout${previewOpen ? " has-preview" : ""}`.trim()}>
        <div className="data-table-wrap files-table-wrap" hidden={!!listError}>
          {loading ? (
            <div className="files-loading" aria-busy="true" aria-label="正在读取工作区">
              <Skeleton rows={6} />
            </div>
          ) : (
            <>
              <table className="data-table files-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th className="num">大小</th>
                    <th>修改时间</th>
                    <th className="num">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((entry) => {
                    const visual = fileVisual(entry);
                    const isFolder = entry.kind === "directory";
                    return (
                      <tr
                        key={entry.path}
                        className="clickable"
                        data-active={selectedPath === entry.path ? "true" : undefined}
                        onClick={() => (isFolder ? openFolder(entry.path) : setSelectedPath(entry.path))}
                      >
                        <td>
                          <span className="files-cell-name">
                            <span className="files-icon" data-kind={visual.tone} aria-hidden="true">
                              {visual.icon}
                            </span>
                            <button
                              type="button"
                              className="files-name"
                              title={entry.path}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isFolder) openFolder(entry.path);
                                else setSelectedPath(entry.path);
                              }}
                            >
                              {entry.name}
                            </button>
                            {entry.kind === "symlink" && <span className="tag files-symlink">符号链接</span>}
                          </span>
                        </td>
                        <td className="num quiet">{isFolder ? "—" : fmtBytes(entry.size)}</td>
                        <td className="quiet files-time">{fmt(entry.modified_at)}</td>
                        <td>
                          <div className="files-actions" onClick={(event) => event.stopPropagation()}>
                            {entry.kind === "file" && (
                              <a
                                className="icon-button"
                                aria-label={`下载 ${entry.name}`}
                                title="下载"
                                href={`/api${path(
                                  projectId,
                                  `/workspace/content?path=${encodeURIComponent(entry.path)}`,
                                )}`}
                                download
                              >
                                <Download size={14} />
                              </a>
                            )}
                            <button
                              type="button"
                              className="icon-button files-delete"
                              aria-label={`删除 ${entry.name}`}
                              title="删除"
                              onClick={() => {
                                setConfirmed(false);
                                setRemove(entry);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!files.length && !listError && (
                <EmptyState
                  icon={<Folder size={20} />}
                  title="文件夹为空"
                  desc="执行任务写入工作区后，文件会出现在这里。"
                  compact
                />
              )}

              {truncated && <p className="files-truncated">当前目录只显示前 5000 项，进入子目录可继续浏览。</p>}
            </>
          )}
        </div>

        {selected && (
          <aside className="files-preview" aria-label="文件预览">
            <header className="files-preview-head">
              <div className="files-preview-ident">
                <span className="files-icon" data-kind={selectedVisual?.tone || "binary"} aria-hidden="true">
                  {selectedVisual?.icon}
                </span>
                <div>
                  <strong className="files-preview-name" title={selected.name}>
                    {selected.name}
                  </strong>
                  <small className="mono files-preview-path" title={selected.path}>
                    /workspace/{selected.path}
                  </small>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭预览"
                title="关闭预览"
                onClick={() => setSelectedPath(null)}
              >
                <X size={15} />
              </button>
            </header>

            <dl className="meta-list files-preview-meta">
              <dt>类型</dt>
              <dd>{selectedVisual?.label || "文件"}</dd>
              <dt>大小</dt>
              <dd>{fmtBytes(selected.size)}</dd>
              <dt>修改</dt>
              <dd>{fmt(selected.modified_at)}</dd>
            </dl>

            <div className="files-preview-body">
              {selected.kind === "symlink" ? (
                <p className="files-preview-note">
                  符号链接只记录指向关系，请在容器内打开实际文件；下载会读取链接目标。
                </p>
              ) : !state || state.status === "loading" ? (
                <div className="files-preview-loading" aria-busy="true" aria-label="正在读取文件">
                  <Skeleton rows={5} />
                </div>
              ) : state.status === "error" ? (
                <p className="files-preview-note" role="alert">
                  {state.message}
                </p>
              ) : state.binary ? (
                <div className="files-binary">
                  <strong>二进制内容，无法预览</strong>
                  <span className="quiet">下载后可本地查看。</span>
                </div>
              ) : (
                <>
                  {isMarkdown(selected.name) ? (
                    <RichText className="files-preview-md" text={state.text} />
                  ) : (
                    <pre className="files-preview-pre">{state.text || "（文件内容为空）"}</pre>
                  )}
                  {state.truncated && (
                    <p className="files-truncation-note">仅预览前 {PREVIEW_LIMIT_LABEL}，下载可获取完整文件。</p>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {remove && (
        <Modal
          label="删除工作区文件"
          title={remove.kind === "directory" ? "删除文件夹" : "删除文件"}
          onClose={closeRemove}
          busy={ws.busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed) return;
            submitRemove();
          }}
          footer={
            <>
              <button type="button" className="button ghost" disabled={ws.busy} onClick={closeRemove}>
                取消
              </button>
              <button type="submit" className="button danger" disabled={!confirmed || ws.busy}>
                {ws.busy ? "删除中…" : "永久删除"}
              </button>
            </>
          }
        >
          <p className="files-modal-path">/workspace/{remove.path}</p>
          <p className="files-modal-copy">
            {remove.kind === "directory" ? "该文件夹及其全部内容将被永久删除。" : "该文件将被永久删除。"}
            已归档证据保留，工作区文件无法由此页面恢复。
          </p>
          {running && <p className="banner warn files-modal-warn">项目正在运行，删除可能影响执行中的任务。</p>}
          <label className="files-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={ws.busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              我了解
              {remove.kind === "directory" ? "该文件夹及其内容" : "该文件"}
              删除后无法恢复。
            </span>
          </label>
        </Modal>
      )}
    </section>
  );
}
