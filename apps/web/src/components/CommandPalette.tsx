import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Bug,
  ClipboardCheck,
  CornerDownLeft,
  FileSearch,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Globe2,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Moon,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  MessagesSquare,
} from "lucide-react";
import type { Graph, OverviewFinding, ProjectSummary } from "../../../../packages/protocol/src/index.js";
import { severityLabels, statusLabels } from "../format.js";
import { pageTitles, workspacePages, type Page, type ProjectPage } from "../workspace.js";
import { modeLabels, normalizedMode } from "./ModeBadge.js";
import { Kbd } from "./ui.js";
import { useDialogFocus } from "./useDialogFocus.js";

const projectIcons: Record<ProjectPage, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  retry: RotateCcw,
  peers: Users,
  messages: MessagesSquare,
  findings: Bug,
  review: ClipboardCheck,
  assets: Globe2,
  blackboard: GitBranch,
  tasks: ListChecks,
  traffic: Activity,
  evidence: FileSearch,
  files: FolderOpen,
  timeline: History,
};

const workspaceIcons: Record<string, typeof ShieldCheck> = {
  security: ShieldCheck,
  vulns: Bug,
  reviews: ClipboardCheck,
  projects: FolderKanban,
  settings: Settings,
};

type Item = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  projects,
  graph,
  currentId,
  findings,
  theme,
  onNavigate,
  onOpenProject,
  onOpenFinding,
  onLocate,
  onNew,
  onToggleTheme,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  graph: Graph | null;
  currentId: string | null;
  findings: OverviewFinding[];
  theme: "light" | "dark";
  onNavigate: (page: Page) => void;
  onOpenProject: (id: string) => void;
  onOpenFinding: (projectId: string, findingId: string) => void;
  onLocate: (id: string) => void;
  onNew: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialogRef, onClose);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const pages: (readonly [Page, string])[] = [...workspacePages];
    if (graph) {
      const swarm = graph.project.mode === "swarm";
      for (const [key, label] of Object.entries(pageTitles)) {
        if (!(key in projectIcons)) continue;
        // swarm 没有 Step：隐藏以 Step 为中心的「人工重试」；决策者架构不显示「执行者」。
        if (swarm ? key === "retry" : key === "peers" || key === "messages") continue;
        pages.push([key as ProjectPage, label]);
      }
    }
    for (const [key, label] of pages) {
      const Icon = workspaceIcons[key] || projectIcons[key as ProjectPage] || LayoutDashboard;
      list.push({
        key: `page-${key}`,
        group: "页面",
        label,
        hint: key in projectIcons ? "当前项目" : "工作区",
        icon: <Icon size={15} />,
        run: () => onNavigate(key),
      });
    }
    for (const project of projects) {
      list.push({
        key: `project-${project.id}`,
        group: "项目",
        label: project.title,
        hint: `${statusLabels[project.status] || project.status} · ${modeLabels[normalizedMode(project.mode)].short} · ${project.finding_count} 项发现`,
        icon: <FolderKanban size={15} />,
        run: () => onOpenProject(project.id),
      });
    }
    if (graph) {
      const records: Item[] = [
        ...graph.findings.map((finding) => ({
          key: `finding-${finding.id}`,
          group: "当前项目",
          label: finding.title,
          hint: `${finding.id} · ${severityLabels[finding.severity || "ungraded"]}`,
          icon: <Bug size={15} />,
          tone: finding.severity || "ungraded",
          run: () => onLocate(finding.id),
        })),
        ...graph.steps.map((step) => ({
          key: `step-${step.id}`,
          group: "当前项目",
          label: step.description,
          hint: `${step.id} · ${step.concluded_at ? "已完成" : step.worker ? "执行中" : "待领取"}`,
          icon: <ListChecks size={15} />,
          run: () => onLocate(step.id),
        })),
        ...graph.facts.map((fact) => ({
          key: `fact-${fact.id}`,
          group: "当前项目",
          label: fact.conclusion || fact.description,
          hint: fact.id,
          icon: <GitBranch size={15} />,
          run: () => onLocate(fact.id),
        })),
        ...graph.evidence.map((evidence) => ({
          key: `evidence-${evidence.id}`,
          group: "当前项目",
          label: evidence.title,
          hint: evidence.id,
          icon: <FileSearch size={15} />,
          run: () => onLocate(evidence.id),
        })),
      ];
      list.push(...records);
    }
    for (const finding of findings) {
      if (finding.project_id === currentId) continue;
      list.push({
        key: `all-${finding.project_id}-${finding.id}`,
        group: "全部漏洞",
        label: finding.title,
        hint: `${finding.project_title} · ${severityLabels[finding.severity]}`,
        icon: <Bug size={15} />,
        tone: finding.severity,
        run: () => onOpenFinding(finding.project_id, finding.id),
      });
    }
    list.push(
      {
        key: "action-new",
        group: "操作",
        label: "新建探索项目",
        hint: "N",
        icon: <Plus size={15} />,
        run: onNew,
      },
      {
        key: "action-theme",
        group: "操作",
        label: theme === "light" ? "切换到深色主题" : "切换到浅色主题",
        icon: theme === "light" ? <Moon size={15} /> : <Sun size={15} />,
        run: onToggleTheme,
      },
      {
        key: "action-logout",
        group: "操作",
        label: "退出登录",
        icon: <LogOut size={15} />,
        run: onLogout,
      },
    );
    return list;
  }, [
    graph,
    projects,
    findings,
    currentId,
    theme,
    onNavigate,
    onOpenProject,
    onOpenFinding,
    onLocate,
    onNew,
    onToggleTheme,
    onLogout,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? items.filter((item) => `${item.label} ${item.hint || ""} ${item.group}`.toLowerCase().includes(needle))
      : items.filter((item) => item.group !== "当前项目" && item.group !== "全部漏洞");
    const order = ["页面", "项目", "当前项目", "全部漏洞", "操作"];
    return matched.sort((left, right) => order.indexOf(left.group) - order.indexOf(right.group)).slice(0, 40);
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => Math.max(0, Math.min(value + 1, filtered.length - 1)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter") {
        const item = filtered[active];
        if (item) {
          event.preventDefault();
          item.run();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, active, onClose]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let lastGroup = "";
  return createPortal(
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label="命令面板" tabIndex={-1}>
        <div className="palette-input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索页面、项目、漏洞与记录…"
            aria-label="搜索"
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="palette-results" ref={listRef}>
          {filtered.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  type="button"
                  data-index={index}
                  data-active={index === active || undefined}
                  data-tone={item.tone}
                  onMouseMove={() => setActive(index)}
                  onClick={() => {
                    item.run();
                    onClose();
                  }}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {index === active && <CornerDownLeft size={13} className="palette-enter" />}
                </button>
              </div>
            );
          })}
          {!filtered.length && (
            <div className="palette-empty">
              没有匹配项
              <small>试试项目名、漏洞标题或页面名</small>
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 选择
          </span>
          <span>
            <Kbd>↵</Kbd> 打开
          </span>
          <span>
            <Kbd>ESC</Kbd> 关闭
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
