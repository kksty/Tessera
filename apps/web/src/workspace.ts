import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type {
  Asset,
  DispatchConfig,
  Event,
  Evidence,
  Fact,
  Finding,
  Graph,
  OverviewFinding,
  ProjectSummary,
  SecurityOverview,
  Step,
} from "../../../packages/protocol/src/index.js";
import type { GraphScope } from "./graph-scope.js";
import { fmt } from "./format.js";

/** 工作区级页面：不依赖具体项目。 */
export type WorkspacePage = "security" | "projects" | "vulns" | "reviews" | "settings";

/** 项目内页面。 */
export type ProjectPage =
  | "overview"
  | "retry"
  | "blackboard"
  | "tasks"
  | "assets"
  | "findings"
  | "review"
  | "evidence"
  | "traffic"
  | "timeline"
  | "files";

export type Page = WorkspacePage | ProjectPage;

export type ModalName = "create" | "rename" | "reopen" | "discard" | null;

/** Open one captured HTTP flow, optionally showing where the operator came from. */
export type TrafficTarget = { flowId: string; findingId?: string; label?: string };

export type RuntimeModel = DispatchConfig["model"] & { api_key_set?: boolean };

export type RuntimeConfig = Omit<
  DispatchConfig,
  "server" | "worker_image" | "network" | "volume_prefix" | "model" | "review_model"
> & {
  read_only_fields?: string[];
  model: RuntimeModel;
  review_model?: RuntimeModel;
};

export const workspacePages: readOnlyPages = [
  ["security", "安全总览"],
  ["vulns", "漏洞库"],
  ["reviews", "审核队列"],
  ["projects", "项目"],
  ["settings", "设置"],
];

export const projectPages: readOnlyPages = [
  ["overview", "项目概览"],
  ["retry", "人工重试"],
  ["findings", "发现"],
  ["review", "审核队列"],
  ["assets", "资产与范围"],
  ["blackboard", "黑板"],
  ["tasks", "任务与运行"],
  ["traffic", "流量"],
  ["evidence", "证据"],
  ["files", "项目文件"],
  ["timeline", "时间线"],
];

type readOnlyPages = readonly (readonly [Page, string])[];

export const pageTitles: Record<string, string> = Object.fromEntries([...workspacePages, ...projectPages]);

/** 侧栏分组：项目页按用途分组，探索放在最前面。 */
export const projectNavGroups: readonly (readonly [string, readonly (readonly [ProjectPage, string])[]])[] = [
  [
    "概览",
    [
      ["overview", "项目概览"],
      ["retry", "人工重试"],
    ],
  ],
  [
    "探索",
    [
      ["blackboard", "探索"],
      ["timeline", "时间线"],
      ["traffic", "流量"],
    ],
  ],
  [
    "安全",
    [
      ["findings", "发现"],
      ["review", "审核队列"],
      ["assets", "资产与范围"],
    ],
  ],
  [
    "资料",
    [
      ["evidence", "证据"],
      ["files", "项目文件"],
    ],
  ],
];

export interface Workspace {
  page: Page;
  id: string | null;
  graph: Graph | null;
  visible: Graph | null;
  graphId: string;
  events: Event[];
  /** 只会改变黑板画面的历史时刻；黑板时间线与回放共用这一条序列。 */
  boardEvents: Event[];
  projects: ProjectSummary[];
  overview: SecurityOverview | null;
  overviewLoading: boolean;
  allFindings: OverviewFinding[];
  reviewFindings: OverviewFinding[];
  config: RuntimeConfig | null;
  theme: "light" | "dark";
  /** 证据正文默认是否按 Markdown 渲染；关闭后一律显示未渲染原文。 */
  markdownRendering: boolean;
  selected: string | null;
  selectedNodes: string[];
  selectedFacts: string[];
  graphScope: GraphScope | null;
  historyTab: "detail" | "history";
  replayIndex: number | null;
  playing: boolean;
  speed: number;
  focus: { id: string; seq: number } | null;
  panelWidth: number;
  query: string;
  checked: string[];
  projectFilter: string;
  hint: string;
  busy: boolean;
  error: string;
  message: string;
  evidencePreview: { item: Evidence; text?: string } | null;
  findingSeverity: string;
  focusFinding: { projectId: string; findingId: string } | null;
  /** Set when a Finding opens its captured flow in the Traffic page. */
  trafficTarget: TrafficTarget | null;
  paletteOpen: boolean;
  refreshing: boolean;
  node: any;
  displayStep?: Step;
  displayFact?: Fact;
  displayFinding?: Finding;
  sources: string[];
  filteredAssets: Asset[];
  navigate: (page: Page, options?: { top?: boolean; anchor?: string }) => void;
  action: (fn: () => Promise<unknown>) => Promise<boolean>;
  refresh: () => Promise<void>;
  openProject: (id: string, page?: ProjectPage) => void;
  openInGraph: (scope: GraphScope) => void;
  clearGraphScope: () => void;
  setGraphScope: (scope: GraphScope | null) => void;
  showEvidence: (item: Evidence) => Promise<void>;
  returnFromEvidence: () => void;
  linkEvidence: (ids: string[]) => ReactNode;
  resizePanel: (e: React.PointerEvent<HTMLDivElement>) => void;
  selectNode: (id: string | null, additive?: boolean) => void;
  setSelected: (id: string | null) => void;
  setSelectedFacts: (ids: string[]) => void;
  setHistoryTab: (tab: "detail" | "history") => void;
  setReplayIndex: (index: number | null) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setFocus: (focus: { id: string; seq: number } | null) => void;
  setPanelWidth: (width: number) => void;
  setQuery: (query: string) => void;
  setChecked: (ids: string[]) => void;
  setProjectFilter: (filter: string) => void;
  setHint: (hint: string) => void;
  setEvidencePreview: (value: { item: Evidence; text?: string } | null) => void;
  setConfig: (config: RuntimeConfig) => void;
  setModal: (modal: ModalName) => void;
  setMessage: (message: string) => void;
  setError: (error: string) => void;
  setFindingSeverity: (value: string) => void;
  /** 全局跳转到一个具体发现：打开项目并定位卡片。 */
  openFinding: (projectId: string, findingId: string) => void;
  /** Open an exact captured flow in the Traffic page. */
  openTraffic: (target: TrafficTarget) => void;
  clearFocusFinding: () => void;
  setPaletteOpen: (open: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  setMarkdownRendering: (value: boolean) => void;
}

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace() {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("Workspace context is not available");
  return ws;
}

export { fmt };

/** 展示 API 错误的 detail，并整理当前调度器的项目/任务包装。 */
export function readableError(raw?: string): string {
  if (!raw) return "";
  let text = raw.trim();
  const json = text.match(/\{[\s\S]*$/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      const detail = parsed.detail ?? parsed.message;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
      if (Array.isArray(detail)) {
        const messages = detail.map((item: { message?: string }) => item?.message).filter(Boolean);
        if (messages.length) return messages.join("；");
      }
    } catch {}
  }
  const wrapped = text.match(/^[\w.-]+\s+\w+:\s*\(?\s*(.+)$/);
  if (wrapped && /^(API \d|Invalid|Unknown|Asset|Step|Graph|Passing)/.test(wrapped[1])) text = wrapped[1];
  return text.replace(/[)\s]+$/, "");
}

export const tokenTotal = (graph: Graph) => graph.usage.reduce((n, u) => n + (u.input || 0) + (u.output || 0), 0);

export function stepState(step: Step) {
  return step.discarded
    ? "discarded"
    : step.concluded_at
      ? "done"
      : step.executed_at
        ? "executed"
        : step.worker
          ? "running"
          : step.blocked_run_id
            ? "needs_attention"
            : /^Execution failed:/.test(step.summary)
              ? "failed"
              : "open";
}

export function locateRecord(ws: Workspace, id: string) {
  ws.setReplayIndex(null);
  // 显式定位一个记录 = 跳转，回到总视图，避免目标节点不在当前链路里而看不见。
  ws.clearGraphScope();
  ws.setHistoryTab("detail");
  ws.navigate("blackboard");
  ws.setSelectedFacts([]);
  ws.setSelected(id);
  ws.setFocus({ id, seq: (ws.focus?.seq || 0) + 1 });
}
