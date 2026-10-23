import { useRef, type ReactNode } from "react";
import {
  Activity,
  Bug,
  ChevronLeft,
  ChevronsUpDown,
  ClipboardCheck,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Globe2,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  FileSearch,
} from "lucide-react";
import type {
  Graph,
  ProjectSummary,
} from "../../../../packages/protocol/src/index.js";
import { brand } from "../brand.js";
import { fromNow } from "../format.js";
import { pendingReviews } from "../../../../packages/protocol/src/review-scheduling.js";
import {
  pageTitles,
  projectNavGroups,
  workspacePages,
  type Page,
  type ProjectPage,
  type WorkspacePage,
} from "../workspace.js";
import { LogoLockup, LogoMark } from "./Logo.js";
import { Kbd } from "./ui.js";
import { useDialogFocus } from "./useDialogFocus.js";

const workspaceIcons: Record<WorkspacePage, typeof ShieldCheck> = {
  security: ShieldCheck,
  vulns: Bug,
  reviews: ClipboardCheck,
  projects: FolderKanban,
  settings: Settings,
};

const projectIcons: Record<ProjectPage, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
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

export function Sidebar({
  projects,
  currentId,
  graph,
  page,
  collapsed,
  mobileOpen,
  theme,
  counts,
  onNavigate,
  onOpenProject,
  onNew,
  onSettings,
  onToggleCollapse,
  onToggleTheme,
  onLogout,
  onCloseMobile,
  onOpenProjectPicker,
  username,
}: {
  projects: ProjectSummary[];
  currentId: string | null;
  graph: Graph | null;
  page: Page;
  collapsed: boolean;
  mobileOpen: boolean;
  theme: "light" | "dark";
  counts: { projects: number; findings: number; pendingReview: number };
  onNavigate: (page: Page) => void;
  onOpenProject: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onToggleCollapse: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  onCloseMobile: () => void;
  onOpenProjectPicker: () => void;
  username?: string;
}) {
  const activeProjects = projects.filter((project) => project.status === "active");
  const current = projects.find((project) => project.id === currentId);
  const sidebarRef = useRef<HTMLElement>(null);
  useDialogFocus(mobileOpen, sidebarRef, onCloseMobile);
  return (
    <aside ref={sidebarRef} className="sidebar" data-collapsed={collapsed} data-mobile-open={mobileOpen} role={mobileOpen ? "dialog" : undefined} aria-modal={mobileOpen || undefined} aria-label="工作区导航" tabIndex={-1}>
      <div className="sidebar-head">
        <button
          type="button"
          className="brand"
          onClick={() => {
            onNavigate("security");
            onCloseMobile();
          }}
          title={`${brand.name} · ${brand.philosophy}`}
        >
          <span className="brand-symbol" aria-hidden="true">
            <LogoMark />
          </span>
          <span className="brand-text">
            <strong>{brand.name}</strong>
          </span>
        </button>
        <button
          type="button"
          className="icon-button sidebar-close"
          aria-label="关闭导航"
          onClick={onCloseMobile}
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <nav className="sidebar-scroll" aria-label="主导航">
        {!currentId && (
        <div className="nav-section">
          <span className="nav-section-label">工作区</span>
          {/* 设置常驻侧栏底部，工作区导航里不再重复一份。 */}
          {workspacePages
            .filter(([key]) => key !== "settings")
            .map(([key, label]) => {
            const Icon = workspaceIcons[key as WorkspacePage];
            const active = !currentId && page === key;
            const badge =
              key === "vulns"
                ? counts.findings
                : key === "reviews"
                  ? counts.pendingReview
                : key === "projects"
                  ? counts.projects
                  : undefined;
            return (
              <button
                key={key}
                type="button"
                className="nav-item"
                data-active={active || undefined}
                aria-current={active ? "page" : undefined}
                title={label}
                onClick={() => {
                  onNavigate(key);
                  onCloseMobile();
                }}
              >
                <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
                <span className="nav-label">{label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className="nav-meta">
                    <span className="nav-count" title={key === "reviews" ? `${badge} 条发现待审核` : undefined}>{badge}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        )}

        <div className="nav-section project-section">
          <div className="nav-section-row">
            <span className="nav-section-label">{currentId ? "项目" : "最近项目"}</span>
            <button
              type="button"
              className="nav-section-action"
              aria-label="切换项目"
              title="切换项目"
              onClick={onOpenProjectPicker}
            >
              <ChevronsUpDown size={13} />
            </button>
          </div>
          {currentId && (current || graph?.project) ? (
            <>
              <button
                type="button"
                className="project-chip"
                onClick={() => { onNavigate("overview"); onCloseMobile(); }}
                title={current?.title || graph?.project.title}
              >
                <span
                  className="live-dot project-chip-status"
                  data-status={graph?.project.status || current?.status}
                  aria-hidden="true"
                />
                <span className="project-chip-mark" aria-hidden="true">
                  <FolderKanban size={15} />
                </span>
                <span className="project-chip-text">
                  <strong>{current?.title || graph?.project.title}</strong>
                  <small>
                    {graph?.project.status === "active"
                      ? "运行中"
                      : graph?.project.status === "stopped"
                        ? "已暂停"
                        : graph?.project.status === "completed"
                          ? "已完成"
                          : "读取中"}
                    {graph ? ` · ${graph.steps.filter((step) => !step.concluded_at && !step.discarded).length} 个待办` : ""}
                  </small>
                </span>
              </button>
              <div className="project-nav">
                {projectNavGroups.map(([group, pages]) => (
                  <div className="nav-group" key={group}>
                    <span className="nav-group-label">{group}</span>
                    {pages.map(([key, label]) => {
                      const Icon = projectIcons[key];
                      // /tasks 与 /timeline 渲染同一个页面（任务与运行 / 事件时间线两个视图），
                      // 深链到 tasks 时导航仍然要落在「时间线」这一项上。
                      const active = page === key || (key === "timeline" && page === "tasks");
                      const pending =
                        key === "review" && graph ? pendingReviews(graph).length : undefined;
                      return (
                        <button
                          key={key}
                          type="button"
                          className="nav-item nested"
                          data-active={active || undefined}
                          aria-current={active ? "page" : undefined}
                          title={label}
                          onClick={() => {
                            onNavigate(key);
                            onCloseMobile();
                          }}
                        >
                          <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                          <span className="nav-label">{label}</span>
                          {pending ? (
                            <span className="nav-meta">
                              <span className="nav-count warn">{pending}</span>
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <button type="button" className="new-project" onClick={onNew}>
                <Plus size={15} />
                <span>新建项目</span>
                <Kbd>N</Kbd>
              </button>
              <ul className="recent-projects">
                {projects.slice(0, 5).map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => onOpenProject(project.id)}
                      title={project.title}
                    >
                      <span className="live-dot" data-status={project.status} aria-hidden="true" />
                      <span className="recent-title">{project.title}</span>
                      <span className="recent-time">{fromNow(project.created_at)}</span>
                    </button>
                  </li>
                ))}
                {!projects.length && (
                  <li className="recent-empty">还没有项目。新建一个开始探索。</li>
                )}
              </ul>
            </>
          )}
        </div>
      </nav>

      <div className="sidebar-foot">
        {activeProjects.length ? (
          <div className="sidebar-live" title="正在运行的项目">
            <span className="pulse-dot" aria-hidden="true" />
            {activeProjects.length} 个项目运行中
          </div>
        ) : null}
        <button type="button" className="nav-item" onClick={onSettings} title="设置">
          <Settings size={15} aria-hidden="true" />
          <span className="nav-label">设置</span>
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={onToggleTheme}
          title={theme === "light" ? "切换到深色" : "切换到浅色"}
        >
          {theme === "light" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
          <span className="nav-label">{theme === "light" ? "深色主题" : "浅色主题"}</span>
        </button>
        <div className="sidebar-account">
          <span className="avatar" aria-hidden="true">
            {(username || "T").slice(0, 1).toUpperCase()}
          </span>
          <span className="account-text">
            <strong>{username || "本地操作员"}</strong>
            <small>单账号工作区</small>
          </span>
          <button type="button" className="icon-button" aria-label="退出登录" title="退出登录" onClick={onLogout}>
            <LogOut size={14} />
          </button>
          <button
            type="button"
            className="icon-button collapse-button"
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            title={collapsed ? "展开侧栏" : "折叠侧栏"}
            onClick={onToggleCollapse}
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

const isMacPlatform = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function Topbar({
  page,
  project,
  projectTitle,
  onMenu,
  onBack,
  onSearch,
  onHome,
  onProject,
  actions,
  refreshing,
}: {
  page: Page;
  project: ProjectSummary | null;
  projectTitle?: string;
  onMenu: () => void;
  onBack: () => void;
  onSearch: () => void;
  onHome: () => void;
  onProject: () => void;
  actions?: ReactNode;
  refreshing?: boolean;
}) {
  const inProject = Boolean(projectTitle);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="icon-button nav-toggle" aria-label="打开导航" onClick={onMenu}>
          <Menu size={17} />
        </button>
        {inProject && (
          <button type="button" className="icon-button" aria-label="返回上一页" title="返回上一页" onClick={onBack}>
            <ChevronLeft size={17} />
          </button>
        )}
        <nav className="breadcrumb" aria-label="位置">
          <button type="button" className="crumb" onClick={onHome}>
            工作区
          </button>
          <span className="crumb-sep" aria-hidden="true">/</span>
          {inProject ? (
            <>
              <button type="button" className="crumb" onClick={onProject} title={projectTitle}>
                {projectTitle}
              </button>
              <span className="crumb-sep" aria-hidden="true">/</span>
              <span className="crumb current">{pageTitles[page]}</span>
            </>
          ) : (
            <span className="crumb current">{pageTitles[page]}</span>
          )}
        </nav>
        {project?.status === "active" && (
          <span className="topbar-live" title="实时同步中">
            <span className="pulse-dot" aria-hidden="true" />
            实时
          </span>
        )}
      </div>
      <div className="topbar-right">
        <button type="button" className="search-trigger" onClick={onSearch} aria-label="搜索页面、项目与发现">
          <Search size={14} aria-hidden="true" />
          <span>搜索</span>
          <Kbd>{isMacPlatform() ? "⌘K" : "Ctrl K"}</Kbd>
        </button>
        {refreshing && <span className="sync-dot" aria-label="正在同步" />}
        {actions}
      </div>
    </header>
  );
}

/** 项目内的轻量页头：标题、说明与右侧操作。 */
export function ProjectHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="project-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="project-header-actions">{actions}</div>}
    </header>
  );
}
