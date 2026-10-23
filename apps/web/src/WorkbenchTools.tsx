import { Overlay } from "./components/ui.js";
import { ActionMenu } from "./components/ActionMenu.js";
import { useEffect, useState } from "react";
import {
  Plus,
  Check,
  HeartPulse,
  Unlock,
  FileCheck,
  Settings,
  FileText,
  Copy,
  Trash2,
  Pencil,
  Pause,
  Play,
  RotateCcw,
  Download,
} from "lucide-react";
import type { Graph, ProjectSummary } from "../../../packages/protocol/src/index.js";
import { api, path } from "./api.js";
import { layoutOptions, localPrefs } from "./layouts.js";
import { StepDecision } from "./components/StepDecision.js";
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
  return (
    <div className="project-extras">
      {compact && (
        <ActionMenu
          label="更多项目操作"
          actions={[
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
  const [decisionOpen, setDecisionOpen] = useState(false);
  const s = graph.steps.find((s) => s.id === selectedId),
    actor = localPrefs().actor_name;
  const active = graph.project.status === "active" && !replaying,
    canOwn = !!s && !s.concluded_at && (!s.worker || s.worker === actor);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    let ok = false;
    const description = String(values.get("description"));
    if (modal === "step") {
      const button = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement;
      ok = await afterChange(() =>
        api(path(graph.project.id, "/intents"), {
          from: selectedFacts,
          description,
          creator: actor,
          claim: button?.value === "claim",
        }),
      );
    } else if (modal === "complete")
      ok = await afterChange(() =>
        api(path(graph.project.id, "/complete"), {
          from: selectedFacts,
          description,
          worker: actor,
        }),
      );
    else if (modal === "conclude" && s)
      ok = await afterChange(() =>
        api(path(graph.project.id, `/intents/${s.id}/conclude`), {
          description,
          worker: actor,
        }),
      );
    if (ok) setModal(null);
  }
  return (
    <>
      <div className="workbench-tools">
        <button disabled={!active || !selectedFacts.length} onClick={() => setModal("step")}>
          <Plus size={13} />
          声明 Step
        </button>
        <button disabled={!active || !selectedFacts.length} onClick={() => setModal("complete")}>
          <Check size={13} />
          完成项目
        </button>
        <button
          disabled={!active || !canOwn}
          onClick={() =>
            void afterChange(() =>
              api(path(graph.project.id, `/intents/${s!.id}/heartbeat`), {
                worker: actor,
              }),
            )
          }
        >
          <HeartPulse size={13} />
          {s?.worker === actor ? "Heartbeat" : "Claim"}
        </button>
        <button
          disabled={!active || !s || s.concluded_at !== null || s.worker !== actor}
          onClick={() =>
            void afterChange(() =>
              api(path(graph.project.id, `/intents/${s!.id}/release`), {
                worker: actor,
              }),
            )
          }
        >
          <Unlock size={13} />
          Release
        </button>
        <button disabled={!active || !canOwn} onClick={() => setModal("conclude")}>
          <FileCheck size={13} />
          Conclude
        </button>
        <button disabled={!active || !s} onClick={() => setDecisionOpen(true)}>
          {s?.concluded_at ? <RotateCcw size={13} /> : <Check size={13} />}
          {s?.concluded_at ? "重开任务" : "关闭任务"}
        </button>
        <span className="quiet">
          Actor: {actor}
          {selectedFacts.length ? ` · 已选 ${selectedFacts.length} 个事实` : ""}
        </span>
        {selectedFacts.map((fid) => (
          <button
            key={fid}
            className="source-chip"
            aria-label={`移除已选事实 ${fid}`}
            onClick={() => onRemoveFact(fid)}
          >
            {fid} ×
          </button>
        ))}
      </div>
      {modal && (
        <Overlay>
          <form className="modal legacy-modal" role="dialog" aria-modal="true" aria-label="黑板操作" onSubmit={submit}>
            <h2>
              {
                {
                  step: "声明探索方向",
                  complete: "人工完成项目",
                  conclude: "提交探索结果",
                }[modal]
              }
            </h2>
            <div className="source-links">
              {selectedFacts.map((f) => (
                <span className="badge" key={f}>
                  {f}
                </span>
              ))}
            </div>
            <label>
              {modal === "conclude"
                ? "发现了什么事实？"
                : modal === "complete"
                  ? "为何目标已经满足？"
                  : "准备探索什么？"}
              <textarea name="description" required autoFocus />
            </label>
            <p className="quiet">Actor: {actor}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>
                取消
              </button>
              {modal === "step" && (
                <button name="action" value="declare">
                  声明
                </button>
              )}
              <button className="primary" name="action" value="claim">
                {modal === "step" ? "声明并领取" : "确认"}
              </button>
            </div>
          </form>
        </Overlay>
      )}
      {decisionOpen && s && (
        <StepDecision step={s} onClose={() => setDecisionOpen(false)} onDone={() => setDecisionOpen(false)} />
      )}
    </>
  );
}
export function QuickSidebar({
  graph,
  selectedId,
  onSelect,
}: {
  graph: Graph;
  onSelect: (id: string) => void;
  selectedId?: string | null;
}) {
  const [tab, setTab] = useState<"hints" | "goals" | "findings" | null>(null);
  return (
    <div className="quick-sidebar">
      <div className="quick-tabs">
        {(
          [
            ["hints", "提示 Hints"],
            ["goals", "目标 Goals"],
            ["findings", "发现 Findings"],
          ] as const
        ).map(([value, label]) => (
          <button
            className={tab === value ? "active" : ""}
            key={value}
            onClick={() => setTab(tab === value ? null : value)}
          >
            {label}
            <span>{value === "hints" ? graph.hints.filter((h) => !h.withdrawn_at).length : graph[value].length}</span>
          </button>
        ))}
      </div>
      {tab && (
        <div className="quick-content">
          {tab === "hints"
            ? graph.hints
                .filter((h) => !h.withdrawn_at)
                .slice()
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))
                .map((h) => {
                  const covered = graph.steps.filter((s) => s.hint_ids?.includes(h.id)).map((s) => s.id);
                  return (
                    <button
                      className={`quick-item${selectedId === h.id ? " active" : ""}`}
                      aria-pressed={selectedId === h.id}
                      key={h.id}
                      onClick={() => onSelect(h.id)}
                    >
                      <small>
                        {h.id} · p{h.priority ?? 0} ·{" "}
                        {h.resolved
                          ? h.resolved_by === "operator"
                            ? `已人工确认`
                            : `历史关闭`
                          : covered.length
                            ? `落实 ${covered.join(",")} · 待确认`
                            : "待确认"}
                      </small>
                      <p>{h.content}</p>
                    </button>
                  );
                })
            : tab === "goals"
              ? graph.goals.map((g) => (
                  <button
                    className={`quick-item${selectedId === g.id ? " active" : ""}`}
                    aria-pressed={selectedId === g.id}
                    key={g.id}
                    onClick={() => onSelect(g.id)}
                  >
                    <small>
                      {g.id} · {g.state}
                    </small>
                    <p>{g.description}</p>
                  </button>
                ))
              : graph.findings.map((f) => (
                  <div className="quick-item" key={f.id}>
                    <button onClick={() => onSelect(f.id)}>{f.title}</button>
                    <small>{f.status}</small>
                  </div>
                ))}
          {!graph[tab].length && <p className="quiet">暂无记录</p>}
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
