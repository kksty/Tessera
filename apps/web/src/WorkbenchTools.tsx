import { Badge, Field, Modal, Overlay, Toast } from "./components/ui.js";
import { ActionMenu } from "./components/ActionMenu.js";
import { useEffect, useState } from "react";
import {
  Plus,
  Check,
  FileCheck,
  Flag,
  Settings,
  FileText,
  Copy,
  Trash2,
  Pencil,
  Pause,
  Play,
  RotateCcw,
  Download,
  Archive,
  User,
} from "lucide-react";
import type { Graph, ProjectSummary } from "../../../packages/protocol/src/index.js";
import { api, path } from "./api.js";
import { layoutOptions, localPrefs } from "./layouts.js";
import { fmtBytes, reviewTone, statusLabels } from "./format.js";
import { StepDecision } from "./components/StepDecision.js";
import { nodeReference } from "./node-reference.js";
import { stepState } from "./workspace.js";
type Action = (fn: () => Promise<unknown>) => Promise<boolean>;
export function Preferences({ afterChange }: { afterChange: Action }) {
  const [open, setOpen] = useState(false),
    [prefs, setPrefs] = useState(localPrefs),
    [limits, setLimits] = useState({
      intent_timeout: 120,
      reason_timeout: 120,
    });
  return (
    <>
      <button
        onClick={() => {
          setPrefs(localPrefs());
          setOpen(true);
          void api<typeof limits>("/settings").then(setLimits);
        }}
      >
        <Settings size={14} />
        本地偏好与心跳设置
      </button>
      {open && (
        <Overlay>
          <form
            className="modal legacy-modal"
            role="dialog"
            aria-modal="true"
            aria-label="本地偏好"
            onSubmit={(e) => {
              e.preventDefault();
              void afterChange(() => api("/settings", limits, "PUT")).then((ok) => {
                if (ok) {
                  localStorage.setItem("tessera.localPrefs", JSON.stringify(prefs));
                  window.dispatchEvent(new Event("tessera:prefs"));
                  setOpen(false);
                }
              });
            }}
          >
            <h2>本地偏好与服务设置</h2>
            <label>
              Actor
              <input
                required
                value={prefs.actor_name}
                onChange={(e) => setPrefs({ ...prefs, actor_name: e.target.value })}
              />
            </label>
            <label>
              默认布局
              <select value={prefs.layout_mode} onChange={(e) => setPrefs({ ...prefs, layout_mode: e.target.value })}>
                {layoutOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className="quiet">Actor、默认布局和详情宽度保存在此浏览器。</p>
            <hr />
            <label>
              Step 心跳超时（秒）
              <input
                type="number"
                min={5}
                required
                value={limits.intent_timeout}
                onChange={(e) =>
                  setLimits({
                    ...limits,
                    intent_timeout: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Decide 心跳超时（秒）
              <input
                type="number"
                min={5}
                required
                value={limits.reason_timeout}
                onChange={(e) =>
                  setLimits({
                    ...limits,
                    reason_timeout: Number(e.target.value),
                  })
                }
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button className="primary">保存</button>
            </div>
          </form>
        </Overlay>
      )}
    </>
  );
}
export function ProjectExtras({
  project,
  afterChange,
  onRemoved,
  compact = false,
}: {
  project: Pick<ProjectSummary, "id" | "title" | "status">;
  afterChange: Action;
  onRemoved?: () => void;
  compact?: boolean;
}) {
  const [modal, setModal] = useState<"export" | "delete" | "rename" | "reopen" | null>(null),
    [format, setFormat] = useState("yaml"),
    [exportText, setExportText] = useState(""),
    [copied, setCopied] = useState(false);
  const [deletionPlan, setDeletionPlan] = useState<{
    container: string;
    workspace_volume: string;
    evidence_count: number;
    retry: boolean;
    error?: string;
  } | null>(null);
  const [deletionError, setDeletionError] = useState("");
  const [deletingNow, setDeletingNow] = useState(false);
  /** busy/error/note for the two-phase full-backup export; also mirrored into a toast. */
  const [bundle, setBundle] = useState({ busy: false, error: "", note: "" });
  useEffect(() => {
    if (bundle.busy || !bundle.note) return;
    const timer = setTimeout(() => setBundle((current) => (current.note ? { ...current, note: "" } : current)), 8000);
    return () => clearTimeout(timer);
  }, [bundle.busy, bundle.note]);
  useEffect(() => {
    if (modal === "export") {
      setExportText("读取中…");
      void fetch("/api" + path(project.id, `/export?format=${format}`))
        .then(async (r) => {
          if (!r.ok) throw new Error("读取失败");
          return r.text();
        })
        .then(setExportText)
        .catch((e) => setExportText(e.message));
    }
  }, [modal, format, project.id]);
  useEffect(() => {
    if (modal !== "delete") return;
    let cancelled = false;
    setDeletionPlan(null);
    setDeletionError("");
    void api<NonNullable<typeof deletionPlan>>(path(project.id, "/deletion-plan"))
      .then((plan) => {
        if (!cancelled) {
          setDeletionPlan(plan);
          setDeletionError(plan.error || "");
        }
      })
      .catch((error) => {
        if (!cancelled) setDeletionError(error instanceof Error ? error.message : "读取删除范围失败");
      });
    return () => {
      cancelled = true;
    };
  }, [modal, project.id]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    let ok = false;
    if (modal === "delete") {
      if (!deletionPlan || deletingNow) return;
      setDeletingNow(true);
      setDeletionError("");
      try {
        ok = await afterChange(async () => {
          try {
            return await api(path(project.id), { confirmed: true }, "DELETE");
          } catch (error) {
            setDeletionError(error instanceof Error ? error.message : "删除未完成，可重试");
            setDeletionPlan((previous) => (previous ? { ...previous, retry: true } : previous));
            throw error;
          }
        });
      } finally {
        setDeletingNow(false);
      }
      if (ok) onRemoved?.();
    } else if (modal === "rename")
      ok = await afterChange(() => api(path(project.id, "/title"), { title: data.get("title") }, "PUT"));
    else if (modal === "reopen")
      ok = await afterChange(() =>
        api(path(project.id, "/reopen"), {
          description: data.get("description"),
          creator: localPrefs().actor_name,
        }),
      );
    if (ok) setModal(null);
  }
  async function copyPreview() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(exportText);
        setCopied(true);
        return;
      }
    } catch {}
    const input = document.createElement("textarea");
    input.value = exportText;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    document.body.append(input);
    input.select();
    setCopied(document.execCommand("copy"));
    input.remove();
  }
  // The archive is built by a POST and then streamed from a one-shot URL. A slow
  // or failed export therefore reports itself here instead of navigating the page
  // to /api/.../bundle, where a dead loopback URL (or a JSON error) would replace
  // the workbench until the operator went back and retried.
  async function downloadBundle() {
    if (bundle.busy) return;
    setBundle({ busy: true, error: "", note: "正在服务端打包，较大的项目需要几十秒到几分钟…" });
    try {
      const prepared = await api<{ url: string; filename: string; size: number }>(path(project.id, "/bundles"), {});
      // The download runs through a hidden iframe: if the stream ever fails, the
      // error response lands in that frame and this page stays intact.
      const anchor = document.createElement("a");
      anchor.href = prepared.url;
      anchor.download = prepared.filename;
      anchor.target = "tessera-bundle";
      document.body.append(anchor);
      anchor.click();
      // Firefox aborts a download whose anchor is removed in the same task.
      setTimeout(() => anchor.remove(), 60_000);
      setBundle({ busy: false, error: "", note: `已生成 ${fmtBytes(prepared.size)}，浏览器开始保存` });
    } catch (error) {
      setBundle({
        busy: false,
        note: "",
        error: error instanceof Error ? error.message : "导出失败，请重试",
      });
    }
  }
  return (
    <div className="project-extras">
      {/* The iframe receives the one-shot download; a failed stream can never
          replace the workbench with a raw error response. */}
      <iframe name="tessera-bundle" title="项目备份下载" hidden />
      {compact && (bundle.busy || bundle.error || bundle.note) && (
        <Toast
          message={bundle.busy ? bundle.note : bundle.error || bundle.note}
          tone={bundle.error ? "danger" : "success"}
          onClose={() => setBundle({ busy: false, error: "", note: "" })}
        />
      )}
      {compact && (
        <ActionMenu
          label="更多项目操作"
          actions={[
            {
              label: "导出完整备份（含日志）",
              icon: <Archive size={15} aria-hidden="true" />,
              onSelect: downloadBundle,
            },
            {
              label: "导出项目数据",
              icon: <Download size={15} aria-hidden="true" />,
              onSelect: () => {
                setFormat("yaml");
                setCopied(false);
                setModal("export");
              },
            },
            { label: "重命名项目", icon: <Pencil size={15} aria-hidden="true" />, onSelect: () => setModal("rename") },
            {
              label: "删除项目",
              icon: <Trash2 size={15} aria-hidden="true" />,
              danger: true,
              onSelect: () => setModal("delete"),
            },
          ]}
        />
      )}
      {!compact && (
        <>
          <button
            aria-label={`查看 ${project.title} 的 YAML`}
            onClick={() => {
              setFormat("yaml");
              setModal("export");
            }}
          >
            <FileText size={13} />
            YAML
          </button>
          {!compact && (
            <>
              <button className="icon-button" aria-label={`重命名 ${project.title}`} onClick={() => setModal("rename")}>
                <Pencil size={13} />
              </button>
              {project.status === "completed" ? (
                <button aria-label={`继续评估 ${project.title}`} onClick={() => setModal("reopen")}>
                  <RotateCcw size={13} />
                </button>
              ) : (
                <button
                  aria-label={`${project.status === "active" ? "暂停" : "继续"} ${project.title}`}
                  onClick={() =>
                    void afterChange(() =>
                      api(
                        path(project.id, "/status"),
                        {
                          status: project.status === "active" ? "stopped" : "active",
                        },
                        "PUT",
                      ),
                    )
                  }
                >
                  {project.status === "active" ? <Pause size={13} /> : <Play size={13} />}
                </button>
              )}
            </>
          )}
          <button className="icon-button" aria-label={`删除 ${project.title}`} onClick={() => setModal("delete")}>
            <Trash2 size={13} />
          </button>
        </>
      )}
      {modal === "export" && (
        <Overlay>
          <div className="modal export-modal legacy-modal" role="dialog" aria-modal="true" aria-label="导出预览">
            <div className="modal-heading">
              <h2>{project.title} · 导出预览</h2>
              <button onClick={() => setModal(null)}>关闭</button>
            </div>
            <div className="export-tabs">
              {[
                ["yaml", "YAML"],
                ["timeline", "时间线"],
                ["findings", "Findings"],
                ["fgs", "FGS"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={format === value ? "active" : ""}
                  onClick={() => {
                    setCopied(false);
                    setFormat(value);
                  }}
                >
                  {label}
                </button>
              ))}
              <button onClick={() => void copyPreview()}>
                <Copy size={13} />
                {copied ? "已复制" : "复制"}
              </button>
              <a className="button" href={"/api" + path(project.id, `/export?format=${format}`)} download>
                下载
              </a>
            </div>
            <pre className="export-preview">
              {exportText.split("\n").map((line, i) => (
                <span className={/^\s*[\w-]+:/.test(line) ? "yaml-key" : ""} key={i}>
                  {line + "\n"}
                </span>
              ))}
            </pre>
            <p className="quiet">
              需要带走整份项目（图、运行日志、诊断、流量正文与证据原件）时，使用完整备份；备份可在「项目」页重新导入并继续工作。单个备份上限
              4 GiB，更大的项目请使用整卷备份。
            </p>
            {(bundle.busy || bundle.error || bundle.note) && (
              <p className={bundle.error ? "export-bundle-status danger" : "export-bundle-status quiet"} role="status">
                {bundle.busy ? bundle.note : bundle.error || bundle.note}
                {bundle.error && (
                  <button type="button" className="button small" onClick={() => void downloadBundle()}>
                    重试
                  </button>
                )}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>
                关闭
              </button>
              <button type="button" className="primary" onClick={() => void downloadBundle()} disabled={bundle.busy}>
                <Archive size={14} />
                {bundle.busy ? "正在打包…" : "下载完整备份"}
              </button>
            </div>
          </div>
        </Overlay>
      )}
      {modal && modal !== "export" && (
        <Overlay>
          <form className="modal legacy-modal" role="dialog" aria-modal="true" aria-label="项目操作" onSubmit={submit}>
            <h2>
              {
                {
                  delete: "删除项目",
                  rename: "重命名项目",
                  reopen: "继续评估",
                }[modal]
              }
            </h2>
            {modal === "delete" ? (
              <>
                <p>永久删除「{project.title}」及其全部关联资源。系统会先停止任务，再清理：</p>
                <ul>
                  <li>项目容器及关联的工作区临时容器；容器内运行进程将终止。</li>
                  <li>工作区卷及其中的原始输出、脚本、Pi 会话、提交记录和待补交结果。</li>
                  <li>全部归档证据、图记录、发现与审核、报告、运行记录、诊断和流量记录。</li>
                </ul>
                {deletionPlan ? (
                  <p className="quiet">
                    容器：<code>{deletionPlan.container}</code>
                    <br />
                    工作区卷：<code>{deletionPlan.workspace_volume}</code>
                    <br />
                    归档证据：{deletionPlan.evidence_count} 项
                  </p>
                ) : (
                  !deletionError && <p className="quiet">正在读取删除范围…</p>
                )}
                <p>此操作无法撤销，需要保留的材料请先导出。平台服务、共享数据卷和其他项目保持不变。</p>
                <p className="quiet">清理失败时保留暂停的项目和删除进度，可重试；已删除的部分资源不会恢复。</p>
                {deletionError && <p role="alert">{deletionError}</p>}
                <label className="delete-confirmation">
                  <input type="checkbox" required disabled={deletingNow} />
                  <span>我了解工作区与原始证据将永久删除。</span>
                </label>
              </>
            ) : modal === "rename" ? (
              <label>
                名称
                <input required name="title" defaultValue={project.title} />
              </label>
            ) : (
              <label>
                继续探索的原因
                <textarea required name="description" />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" disabled={deletingNow} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className={modal === "delete" ? "danger" : "primary"}
                disabled={modal === "delete" && (!deletionPlan || deletingNow)}
              >
                {modal === "delete"
                  ? deletingNow
                    ? "正在删除…"
                    : deletionPlan?.retry
                      ? "重试完整删除"
                      : "永久删除全部资源"
                  : "确认"}
              </button>
            </div>
          </form>
        </Overlay>
      )}
    </div>
  );
}
function ManualAction({
  icon,
  title,
  hint,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  tone?: "warn";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="manual-action" data-tone={tone} disabled={disabled} title={hint} onClick={onClick}>
      <span className="manual-action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="manual-action-text">
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
    </button>
  );
}

export function WorkbenchTools({
  graph,
  selectedFacts,
  selectedId,
  replaying,
  afterChange,
  onRemoveFact,
}: {
  graph: Graph;
  selectedFacts: string[];
  selectedId: string | null;
  replaying: boolean;
  afterChange: Action;
  onRemoveFact: (id: string) => void;
}) {
  const [modal, setModal] = useState<"step" | "conclude" | "complete" | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const s = graph.steps.find((s) => s.id === selectedId),
    actor = localPrefs().actor_name,
    selected = selectedId ? nodeReference(graph, selectedId) : null,
    status = s ? stepState(s) : null;
  const active = graph.project.status === "active" && !replaying;
  const canUseTask = active && !!s && !s.discarded;
  const canSubmit = active && !!s && !s.discarded && !s.concluded_at && (!s.worker || s.worker === actor);
  const canDecide = canUseTask;
  const canUseFacts = active && selectedFacts.length > 0;
  const openSteps = graph.steps.filter((step) => !step.deleted && !step.concluded_at && !step.discarded).length;
  const openLeads = (graph.leads ?? []).filter((lead) => lead.status === "open").length;
  const openHints = graph.hints.filter((hint) => !hint.withdrawn_at && !hint.resolved).length;
  const paused =
    graph.project.status === "stopped"
      ? "项目已暂停。先在项目页恢复项目，才能声明、关闭或完成。"
      : graph.project.status === "completed"
        ? "项目已完成。如需继续，先在项目页恢复评估。"
        : "";
  function openModal(next: "step" | "conclude" | "complete") {
    setDescription("");
    setModal(next);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal || !description.trim()) return;
    setSubmitting(true);
    try {
      let ok = false;
      if (modal === "step")
        ok = await afterChange(() =>
          api(path(graph.project.id, "/intents"), {
            from: selectedFacts,
            description: description.trim(),
            creator: actor,
          }),
        );
      else if (modal === "complete")
        ok = await afterChange(() =>
          api(path(graph.project.id, "/complete"), {
            from: selectedFacts,
            description: description.trim(),
            worker: actor,
          }),
        );
      else if (modal === "conclude" && s)
        ok = await afterChange(() =>
          api(path(graph.project.id, `/intents/${s.id}/conclude`), {
            description: description.trim(),
            worker: actor,
          }),
        );
      if (ok) {
        setModal(null);
        setDescription("");
      }
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="manual-panel">
      <div className="manual-context" data-empty={!selectedId || undefined}>
        <div className="manual-context-head">
          <span className="manual-kind">{selected?.kind || "未选择"}</span>
          {selectedId && <span className="manual-node-id mono">{selectedId}</span>}
          {status && <Badge value={status} />}
          <span className="manual-spacer" />
          <span className="manual-actor" title="操作人来自本地偏好">
            <User size={12} aria-hidden="true" />
            {actor}
          </span>
        </div>
        <p className="manual-context-text">{selected?.text || "在黑板中选中任务或事实后，相应操作才会启用。"}</p>
        {!!selectedFacts.length && (
          <div className="manual-selected-facts">
            <span className="quiet">已选 {selectedFacts.length} 条事实</span>
            <div className="source-links">
              {selectedFacts.map((fid) => (
                <button
                  key={fid}
                  type="button"
                  className="manual-source-chip"
                  aria-label={`移除已选事实 ${fid}`}
                  onClick={() => onRemoveFact(fid)}
                >
                  {fid} <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {paused && <p className="manual-note">{paused}</p>}
      {replaying && <p className="manual-note">回放中只能查看；退出回放后才能写入。</p>}

      {s && (
        <section className="manual-section">
          <h3>当前任务</h3>
          <div className="manual-actions">
            {s.discarded ? (
              <p className="manual-empty-line">该任务已废弃，不再接受关闭或重开。</p>
            ) : s.concluded_at ? (
              <ManualAction
                icon={<RotateCcw size={16} />}
                title="重开任务"
                hint="清空关闭记录，让下一次领取直接重跑"
                disabled={!canDecide || submitting}
                onClick={() => setDecisionOpen(true)}
              />
            ) : (
              <>
                <ManualAction
                  icon={<FileCheck size={16} />}
                  title="提交结果"
                  hint={
                    !active
                      ? "项目恢复后可提交"
                      : canSubmit
                        ? "写入一条事实并结束这个任务"
                        : `任务正由 ${s.worker || "其他执行者"} 执行，结束后才能提交`
                  }
                  disabled={!canSubmit || submitting}
                  onClick={() => openModal("conclude")}
                />
                <ManualAction
                  icon={<Check size={16} />}
                  title="关闭任务"
                  hint="不写入事实，只记录关闭理由"
                  disabled={!canDecide || submitting}
                  onClick={() => setDecisionOpen(true)}
                />
              </>
            )}
          </div>
          {s.close_reason && <p className="manual-close-reason">关闭理由：{s.close_reason}</p>}
        </section>
      )}

      <section className="manual-section">
        <h3>新建</h3>
        <div className="manual-actions">
          <ManualAction
            icon={<Plus size={16} />}
            title="声明任务"
            hint={
              replaying
                ? "退出回放后可声明"
                : !active
                  ? "项目恢复后可声明"
                  : selectedFacts.length
                    ? `以选中的 ${selectedFacts.length} 条事实为起点`
                    : "先在黑板选中至少一条事实"
            }
            disabled={!canUseFacts || submitting}
            onClick={() => openModal("step")}
          />
        </div>
      </section>

      <section className="manual-section">
        <h3>项目</h3>
        <div className="manual-actions">
          <ManualAction
            icon={<Flag size={16} />}
            title="完成项目"
            hint={
              replaying
                ? "退出回放后可完成"
                : !active
                  ? "项目恢复后可完成"
                  : !selectedFacts.length
                    ? "先在黑板选中至少一条事实"
                    : openSteps
                      ? `仍有 ${openSteps} 个任务未结束；完成会中断在途执行`
                      : "目标已满足，结束整个项目"
            }
            tone="warn"
            disabled={!canUseFacts || submitting}
            onClick={() => openModal("complete")}
          />
        </div>
      </section>

      {modal && (
        <Modal
          label="黑板操作"
          title={
            {
              step: "声明新任务",
              complete: "人工完成项目",
              conclude: "提交任务结果",
            }[modal]
          }
          onClose={() => setModal(null)}
          onSubmit={submit}
          busy={submitting}
          footer={
            <>
              <button type="button" className="button" disabled={submitting} onClick={() => setModal(null)}>
                取消
              </button>
              <button className="button primary" disabled={submitting || !description.trim()}>
                {submitting
                  ? "提交中…"
                  : modal === "step"
                    ? "声明任务"
                    : modal === "complete"
                      ? "完成项目"
                      : "提交结果"}
              </button>
            </>
          }
        >
          {modal === "step" ? (
            <>
              <p className="quiet">新任务会进入黑板，由调度器交给模型执行，不会自动占有执行权。</p>
              <div className="manual-sources">
                <span className="field-label">来源事实</span>
                <div className="source-links">
                  {selectedFacts.map((f) => (
                    <span className="badge" key={f}>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <Field label="要回答的问题" hint="写成可验证的问题；验收属性和方法建议可在任务详情里补充。">
                <textarea
                  required
                  rows={4}
                  autoFocus
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </>
          ) : modal === "complete" ? (
            <>
              {openSteps > 0 && <p className="banner warn">仍有 {openSteps} 个任务未结束；人工完成会中断在途执行。</p>}
              {openLeads > 0 && <p className="banner warn">还有 {openLeads} 个 open lead 未处置。</p>}
              {openHints > 0 && <p className="banner warn">还有 {openHints} 条 Hint 未确认关闭或撤回。</p>}
              <p className="quiet">完成后项目标记为已完成，目标状态改为已满足；原始证据与历史保留。</p>
              <Field label="为何目标已经满足？" hint="写清覆盖范围与仍未验证的边界，便于日后复核。">
                <textarea
                  required
                  rows={4}
                  autoFocus
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <p className="quiet">
                {s ? `提交后会写入一条事实，并结束 ${s.id}；执行记录和证据保留。` : "提交后写入一条事实。"}
              </p>
              {s && (
                <p className="manual-target mono">
                  {s.id} · {s.description}
                </p>
              )}
              <Field label="发现了什么事实？" hint="只写已由证据支持的内容；不确定的部分留作后续任务。">
                <textarea
                  required
                  rows={4}
                  autoFocus
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </>
          )}
        </Modal>
      )}
      {decisionOpen && s && (
        <StepDecision step={s} onClose={() => setDecisionOpen(false)} onDone={() => setDecisionOpen(false)} />
      )}
    </div>
  );
}
export type QuickTab = "hints" | "goals" | "findings";

type QuickTone = "neutral" | "accent" | "success" | "warn" | "danger";

/** 快速面板的一行：标题和状态先读，正文其次；整行是一张可点的卡片。 */
function QuickItem({
  active,
  meta,
  tag,
  tone,
  title,
  note,
  onClick,
}: {
  active: boolean;
  meta: string;
  tag: string;
  tone: QuickTone;
  title: string;
  note?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`quick-item${active ? " active" : ""}`}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      <span className="quick-item-head">
        <span className="quick-item-meta">{meta}</span>
        <span className="quick-item-tag" data-tone={tone}>
          {tag}
        </span>
      </span>
      <span className="quick-item-title">{title}</span>
      {note && <span className="quick-item-note">{note}</span>}
    </button>
  );
}

const goalStateLabels: Record<string, { label: string; tone: QuickTone }> = {
  active: { label: "进行中", tone: "accent" },
  satisfied: { label: "已满足", tone: "success" },
  withdrawn: { label: "已撤回", tone: "neutral" },
};

export function QuickSidebar({
  graph,
  selectedId,
  tab,
  onTabChange,
  onSelect,
}: {
  graph: Graph;
  selectedId?: string | null;
  tab: QuickTab | null;
  onTabChange: (tab: QuickTab | null) => void;
  onSelect: (id: string) => void;
}) {
  const visibleHints = graph.hints.filter((h) => !h.withdrawn_at);
  return (
    <div className="quick-sidebar">
      <div className="quick-tabs">
        {(
          [
            ["hints", "提示"],
            ["goals", "目标"],
            ["findings", "发现"],
          ] as const
        ).map(([value, label]) => (
          <button
            className={tab === value ? "active" : ""}
            key={value}
            aria-pressed={tab === value}
            title={tab === value ? "收起列表" : "展开列表"}
            onClick={() => onTabChange(tab === value ? null : value)}
          >
            {label}
            <span>{value === "hints" ? visibleHints.length : graph[value].length}</span>
          </button>
        ))}
      </div>
      {tab && (
        <div className="quick-content" key={tab}>
          {tab === "hints"
            ? visibleHints
                .slice()
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
                .map((h) => {
                  const covered = graph.steps.filter((s) => s.hint_ids?.includes(h.id)).map((s) => s.id);
                  const tone: QuickTone = h.resolved
                    ? h.resolved_by === "operator"
                      ? "success"
                      : "neutral"
                    : covered.length
                      ? "accent"
                      : "warn";
                  const status = h.resolved
                    ? h.resolved_by === "operator"
                      ? "已人工确认"
                      : "历史关闭"
                    : covered.length
                      ? "已落实"
                      : "待确认";
                  return (
                    <QuickItem
                      key={h.id}
                      active={selectedId === h.id}
                      meta={`优先级 ${h.priority ?? 0}`}
                      tag={status}
                      tone={tone}
                      title={h.content}
                      note={!h.resolved && covered.length ? `已落实到 ${covered.length} 个任务` : undefined}
                      onClick={() => onSelect(h.id)}
                    />
                  );
                })
            : tab === "goals"
              ? graph.goals.map((g) => {
                  const state = goalStateLabels[g.state] ?? { label: g.state, tone: "neutral" as const };
                  return (
                    <QuickItem
                      key={g.id}
                      active={selectedId === g.id}
                      meta="当前目标"
                      tag={state.label}
                      tone={state.tone}
                      title={g.description}
                      onClick={() => onSelect(g.id)}
                    />
                  );
                })
              : graph.findings.map((f) => (
                  <QuickItem
                    key={f.id}
                    active={selectedId === f.id}
                    meta={`第 ${f.version ?? 1} 版`}
                    tag={statusLabels[f.review_status] || statusLabels[f.status] || f.status}
                    tone={reviewTone(f.review_status)}
                    title={f.title}
                    onClick={() => onSelect(f.id)}
                  />
                ))}
          {(tab === "hints" ? visibleHints.length : graph[tab].length) === 0 && <p className="quick-empty">暂无记录</p>}
        </div>
      )}
    </div>
  );
}
export function ProjectFilter({
  projects,
  value: selected,
  onChange,
}: {
  projects: ProjectSummary[];
  value: string;
  onChange: (status: string) => void;
}) {
  return (
    <div className="project-filter">
      {[
        ["all", "全部"],
        ["active", "运行中"],
        ["stopped", "已暂停"],
        ["completed", "已完成"],
      ].map(([value, label]) => (
        <button
          key={value}
          className={selected === value ? "active" : ""}
          aria-pressed={selected === value}
          onClick={() => onChange(value)}
        >
          {label} <span>{value === "all" ? projects.length : projects.filter((p) => p.status === value).length}</span>
        </button>
      ))}
    </div>
  );
}
