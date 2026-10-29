import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, Ban, Check, FileText, Pause, Play, RotateCcw, Route, Users, X } from "lucide-react";
import type {
  Event,
  Evidence,
  Graph,
  OverviewFinding,
  ProjectMode,
  ProjectSummary,
  SecurityOverview,
} from "../../../packages/protocol/src/index.js";
import { api, path, ApiError } from "./api.js";
import { authLogout, type Session } from "./auth.js";
import { brand } from "./brand.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { RichText } from "./components/RichText.js";
import { Drawer, Modal, Toast } from "./components/ui.js";
import { modeLabels } from "./components/ModeBadge.js";
import { TrafficPreviewModal } from "./components/TrafficInspector.js";
import { Sidebar, Topbar } from "./components/Shell.js";
import { ProjectExtras } from "./WorkbenchTools.js";
import { ProjectUsage } from "./components/ProjectUsage.js";
import { localPrefs } from "./layouts.js";
import { isMarkdownEvidence } from "./markdown.js";
import { readPreference, writePreference } from "./preferences.js";
import { SecurityOverviewPage } from "./pages/SecurityOverview.js";
import { AllFindingsPage } from "./pages/AllFindings.js";
import { ProjectsPage } from "./pages/Projects.js";
import { PeersPage } from "./pages/Peers.js";
import { MessagesPage } from "./pages/Messages.js";
import { ProjectOverviewPage } from "./pages/ProjectOverview.js";
import { FindingsPage } from "./pages/Findings.js";
import { ReviewPage } from "./pages/Review.js";
import { ReviewsPage } from "./pages/Reviews.js";
import { AssetsPage } from "./pages/Assets.js";
import { TimelinePage } from "./pages/Timeline.js";
import { TrafficPage } from "./pages/Traffic.js";
import { EvidencePage } from "./pages/Evidence.js";
import { FilesPage } from "./pages/Files.js";
import { RetryPage } from "./pages/Retry.js";
import { SettingsPage } from "./pages/Settings.js";
import { pageScroll } from "./view-state.js";
import { blackboardEvents, replayBoard } from "./replay.js";
import { eventTargets, type GraphScope } from "./graph-scope.js";
import {
  WorkspaceContext,
  locateRecord,
  pageTitles,
  projectPages,
  workspacePages,
  type ModalName,
  type Page,
  type ProjectPage,
  type RuntimeConfig,
  type TrafficTarget,
  type Workspace,
  type WorkspacePage,
} from "./workspace.js";

const workspaceSet = new Set<string>(workspacePages.map(([key]) => key));
const projectPageSet = new Set<string>(projectPages.map(([key]) => key));
const isWorkspacePage = (page: Page): page is WorkspacePage => workspaceSet.has(page);
const BoardPage = lazy(() => import("./pages/Board.js").then(({ BoardPage }) => ({ default: BoardPage })));

function parseRoute(): { id: string | null; page: Page } {
  const project = location.hash.match(/^#\/projects\/([^/]+)(?:\/([^/]+))?/);
  if (project) {
    const candidate = project[2] || "overview";
    return {
      id: (() => {
        try {
          return decodeURIComponent(project[1]);
        } catch {
          return project[1];
        }
      })(),
      page: projectPageSet.has(candidate) ? (candidate as ProjectPage) : "overview",
    };
  }
  const workspace = location.hash.match(/^#\/(security|projects|vulns|reviews|settings)\b/);
  if (workspace) return { id: null, page: workspace[1] as WorkspacePage };
  return { id: null, page: "security" };
}

const routeHash = (id: string | null, page: Page) =>
  id ? `#/projects/${encodeURIComponent(id)}/${page}` : `#/${page}`;

/**
 * swarm 的 peers/rounds 存在图里，但为了不唤醒全员不推进 revision。刷新时单独比较
 * 这段指纹，否则裂变/退出后侧栏与项目概览的执行者计数会一直停在旧值。
 */
const swarmFingerprint = (graph: Graph) =>
  `${(graph.peers ?? []).map((peer) => `${peer.id}:${peer.status}:${peer.direction ?? ""}`).join(",")}|${(
    graph.rounds ?? []
  )
    .map((round) => `${round.id}:${round.status}`)
    .join(",")}`;

export function App({ session, setSession }: { session: Session; setSession: (session: Session) => void }) {
  const initial = useRef(parseRoute()).current;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [allFindings, setAllFindings] = useState<OverviewFinding[]>([]);
  const [reviewFindings, setReviewFindings] = useState<OverviewFinding[]>([]);
  const [id, setId] = useState<string | null>(initial.id);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [page, setPage] = useState<Page>(initial.page);
  const graphId = "main";
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [historyTab, setHistoryTab] = useState<"detail" | "history">("detail");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalName>(null);
  const [hint, setHint] = useState("");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<{
    item: Evidence;
    text?: string;
  } | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [selectedFacts, setSelectedFacts] = useState<string[]>([]);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const [graphScope, setGraphScope] = useState<GraphScope | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [newHints, setNewHints] = useState([""]);
  const [newMode, setNewMode] = useState<ProjectMode>("classic");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1100);
  const [message, setMessage] = useState("");
  const [findingSeverity, setFindingSeverity] = useState("all");
  const [theme, setThemeState] = useState<"light" | "dark">(() =>
    readPreference("tessera.theme") === "dark" ? "dark" : "light",
  );
  const [markdownRendering, setMarkdownRenderingState] = useState(
    () => readPreference("tessera.evidenceMarkdown") !== "false",
  );
  const setMarkdownRendering = (value: boolean) => {
    setMarkdownRenderingState(value);
    writePreference("tessera.evidenceMarkdown", String(value));
  };
  const [collapsed, setCollapsed] = useState(() => readPreference("tessera.sidebarCollapsed") === "true");
  const [mobileNav, setMobileNav] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(280, Math.min(720, Number(readPreference("tessera.sidePanelWidth")) || 360)),
  );
  const [focusFinding, setFocusFinding] = useState<{
    projectId: string;
    findingId: string;
  } | null>(null);
  const [trafficTarget, setTrafficTarget] = useState<TrafficTarget | null>(null);
  const [trafficPreview, setTrafficPreview] = useState<TrafficTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const authenticated = session?.authenticated === true;
  // 时间线和回放按「图有变化」推进：用量与证据归档不产生新的画面时刻。
  const graphEvents = useMemo(() => blackboardEvents(events), [events]);

  const backStack = useRef<
    Array<{
      id: string | null;
      page: Page;
      selected: string | null;
      selectedNodes: string[];
      selectedFacts: string[];
      scope: GraphScope | null;
      historyTab: "detail" | "history";
      replayIndex: number | null;
      scrollTop: number;
    }>
  >([]);
  const projectViews = useRef(
    new Map<
      string,
      {
        page: Page;
        selected: string | null;
        selectedNodes: string[];
        selectedFacts: string[];
        historyTab: "detail" | "history";
        query: string;
        checked: string[];
      }
    >(),
  );
  const evidenceRequest = useRef(0);
  type EvidenceBookmark = {
    projectId: string;
    page: Page;
    scrollTop: number;
    anchorId?: string;
    offset?: number;
  };
  const [evidenceReturn, setEvidenceReturn] = useState<EvidenceBookmark | null>(null);
  const restoringEvidence = useRef<EvidenceBookmark | null>(null);
  const scrollKey = `${id || "workspace"}:${page}`;
  const pendingNavigation = useRef<{ projectId: string | null; page: Page; anchor?: string } | null>(null);
  const [navigationSequence, setNavigationSequence] = useState(0);

  const rememberNavigation = () => {
    const container = document.querySelector<HTMLElement>(".content");
    backStack.current.push({
      id,
      page,
      selected: selectedValue,
      selectedNodes: [...selectedNodes],
      selectedFacts: [...selectedFacts],
      scope: graphScope,
      historyTab,
      replayIndex,
      scrollTop: container?.scrollTop ?? 0,
    });
    if (backStack.current.length > 40) backStack.current.shift();
  };
  const rememberView = () => {
    const container = document.querySelector<HTMLElement>(".content");
    if (container) pageScroll.set(scrollKey, container.scrollTop);
    if (id)
      projectViews.current.set(id, {
        page,
        selected: selectedValue,
        selectedNodes,
        selectedFacts,
        historyTab,
        query,
        checked,
      });
  };

  useEffect(() => {
    if (restoringEvidence.current) return;
    const frame = requestAnimationFrame(() => {
      const container = document.querySelector<HTMLElement>(".content");
      const request = pendingNavigation.current;
      if (container && request && request.page === page && request.projectId === id) {
        container.scrollTop = 0;
        document.querySelectorAll(".navigation-target").forEach((el) => el.classList.remove("navigation-target"));
        const anchor = request.anchor ? document.getElementById(request.anchor) : null;
        if (anchor) {
          container.scrollTop = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
          anchor.classList.add("navigation-target");
          anchor.focus({ preventScroll: true });
        }
        pendingNavigation.current = null;
      } else if (container) container.scrollTop = pageScroll.get(scrollKey) || 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollKey, graph?.project.id, navigationSequence]);

  useEffect(() => {
    const bookmark = restoringEvidence.current;
    if (!bookmark || bookmark.page !== page || bookmark.projectId !== id) return;
    const frame = requestAnimationFrame(() => {
      const container = document.querySelector<HTMLElement>(".content");
      const anchor = bookmark.anchorId ? document.getElementById(bookmark.anchorId) : null;
      if (container)
        container.scrollTop =
          anchor && bookmark.offset !== undefined
            ? container.scrollTop +
              anchor.getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              bookmark.offset
            : bookmark.scrollTop;
      restoringEvidence.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, id]);

  const sequence = useRef(0);
  const eventCursor = useRef(0);
  const currentId = useRef(id);
  currentId.current = id;

  const loadOverview = useCallback(async (seq: number) => {
    setOverviewLoading(true);
    try {
      const [nextOverview, nextFindings, nextReviews] = await Promise.all([
        api<SecurityOverview>("/overview"),
        api<OverviewFinding[]>("/findings"),
        api<OverviewFinding[]>("/reviews"),
      ]);
      if (seq !== sequence.current) return;
      setOverview(nextOverview);
      setAllFindings(nextFindings);
      setReviewFindings(nextReviews);
      // 兼容性提示不属于总览数据，但它的计数会随审核结束而变化。
      window.dispatchEvent(new Event("tessera:workspace-refreshed"));
    } catch (failure) {
      if (seq === sequence.current) setLoadError(failure instanceof Error ? failure.message : "读取总览失败");
    } finally {
      if (seq === sequence.current) setOverviewLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    setRefreshing(true);
    try {
      const target = currentId.current;
      const listRequest = api<ProjectSummary[]>("/projects");
      if (!target) {
        setLoadError("");
        const [list] = await Promise.all([listRequest, loadOverview(seq)]);
        if (seq === sequence.current) setProjects(list);
        return;
      }
      const [list, nextGraph] = await Promise.all([listRequest, api<Graph>(path(target))]);
      if (seq !== sequence.current) return;
      setProjects(list);
      setGraph((old) =>
        old?.project.id === nextGraph.project.id &&
        old.revision === nextGraph.revision &&
        swarmFingerprint(old) === swarmFingerprint(nextGraph)
          ? old
          : nextGraph,
      );
      let cursor = eventCursor.current;
      const additions: Event[] = [];
      let moreEvents = false;
      for (let i = 0; i < 20; i++) {
        const batch = await api<Event[]>(path(target, `/fgs/events?after=${cursor}`));
        additions.push(...batch);
        if (batch.length) cursor = batch[batch.length - 1].seq;
        moreEvents = batch.length === 500;
        if (!moreEvents) break;
      }
      if (seq !== sequence.current) return;
      setLoadError("");
      eventCursor.current = cursor;
      if (moreEvents)
        setTimeout(() => {
          if (seq === sequence.current) void refresh();
        }, 0);
      if (additions.length)
        setEvents((old) => {
          const known = new Set(old.map((event) => event.seq));
          return [...old, ...additions.filter((event) => !known.has(event.seq))];
        });
    } catch (failure) {
      if (seq !== sequence.current) return;
      if (failure instanceof ApiError && failure.status === 404 && currentId.current) {
        sequence.current++;
        currentId.current = null;
        backStack.current = [];
        setId(null);
        setGraph(null);
        setEvents([]);
        eventCursor.current = 0;
        history.replaceState(null, "", "#/security");
        setPage("security");
        setLoadError("");
        return;
      }
      setLoadError(failure instanceof Error ? failure.message : "读取失败");
    } finally {
      if (seq === sequence.current) setRefreshing(false);
    }
  }, [loadOverview]);

  useEffect(() => {
    const followLocation = () => {
      const route = parseRoute();
      if (route.id === id && route.page === page) return;
      rememberView();
      setTrafficTarget(null);
      if (route.id !== id) {
        sequence.current++;
        currentId.current = route.id;
        backStack.current = [];
        setGraph(null);
        setEvents([]);
        eventCursor.current = 0;
      }
      evidenceRequest.current++;
      setEvidencePreview(null);
      setEvidenceReturn(null);
      setPlaying(false);
      setMobileNav(false);
      if (route.page !== "findings") setFocusFinding(null);
      setId(route.id);
      setPage(route.page);
    };
    window.addEventListener("hashchange", followLocation);
    window.addEventListener("popstate", followLocation);
    return () => {
      window.removeEventListener("hashchange", followLocation);
      window.removeEventListener("popstate", followLocation);
    };
  }, [id, page, graphId, selectedValue, selectedNodes, selectedFacts, historyTab, query, checked]);

  useEffect(() => {
    const drop = () => setSession({ authenticated: false });
    window.addEventListener("tessera:unauthorized", drop);
    return () => window.removeEventListener("tessera:unauthorized", drop);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const saved = id ? projectViews.current.get(id) : undefined;
    eventCursor.current = 0;
    setEvents([]);
    setGraph(null);
    setReplayIndex(null);
    setGraphScope(null);
    setSelectedValue(saved?.selected || null);
    setSelectedNodes(saved?.selectedNodes || (saved?.selected ? [saved.selected] : []));
    setSelectedFacts(saved?.selectedFacts || []);
    setChecked(saved?.checked || []);
    setEvidencePreview(null);
    setQuery(saved?.query || "");
    setHistoryTab(saved?.historyTab || "detail");
    void refresh();
  }, [id, authenticated, refresh]);

  // 架构决定哪些页面存在：决策者架构没有执行者/消息，蜂群架构没有 Step 重试。
  // 深链或旧会话落在不属于该架构的页面时，归一到当前架构的入口，避免空白页。
  useEffect(() => {
    if (!graph || !id) return;
    const swarm = graph.project.mode === "swarm";
    const invalid = swarm ? page === "retry" : page === "peers" || page === "messages";
    if (!invalid) return;
    const fallback: ProjectPage = swarm ? "timeline" : "overview";
    setPage(fallback);
    history.replaceState(null, "", routeHash(id, fallback));
  }, [graph, id, page]);

  useEffect(() => {
    if (!authenticated) return;
    const stream = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pending = false;
    let active = true;
    // Bursts of worker events share one refresh. If more arrive during a
    // request, fetch once again afterwards instead of racing stale responses.
    const schedule = () => {
      pending = true;
      if (!active || running || timer !== undefined) return;
      timer = setTimeout(async () => {
        timer = undefined;
        pending = false;
        running = true;
        try {
          await refresh();
        } finally {
          running = false;
          if (active && pending) schedule();
        }
      }, 120);
    };
    stream.addEventListener("refresh", schedule);
    return () => {
      active = false;
      clearTimeout(timer);
      stream.close();
    };
  }, [refresh, authenticated]);

  useEffect(() => {
    if (authenticated && page === "settings" && !config)
      void api<RuntimeConfig>("/runtime")
        .then(setConfig)
        .catch((failure) => setError(failure.message));
  }, [page, authenticated, config]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference("tessera.theme", theme);
  }, [theme]);

  useEffect(() => {
    writePreference("tessera.sidebarCollapsed", String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    const desktop = matchMedia("(min-width: 901px)");
    const closeMobile = () => {
      if (desktop.matches) setMobileNav(false);
    };
    desktop.addEventListener("change", closeMobile);
    return () => desktop.removeEventListener("change", closeMobile);
  }, []);

  // 全局快捷键：⌘/Ctrl + K 打开命令面板；工作区按 N 新建项目。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (modal) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (!authenticated || id || modal || paletteOpen || mobileNav) return;
      if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      setModal("create");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authenticated, id, modal, paletteOpen, mobileNav]);

  useEffect(() => {
    document.title = graph
      ? `${graph.project.title} · ${brand.name}`
      : page === "settings"
        ? `设置 · ${brand.name}`
        : `${pageTitles[page]} · ${brand.name}`;
  }, [graph?.project.title, page]);

  useEffect(() => {
    if (!playing || replayIndex === null) return;
    if (replayIndex >= graphEvents.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setReplayIndex((index) => (index ?? 0) + 1), speed);
    return () => clearTimeout(timer);
  }, [playing, replayIndex, speed, graphEvents.length]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (replayIndex === null || !playing || !graph) return;
    const event = graphEvents[replayIndex];
    if (!event) return;
    const targets = eventTargets(graph, event);
    if (targets.length) setSelected(targets[0]);
  }, [replayIndex, playing]);

  // 命令面板打开时按需补齐跨项目漏洞列表。
  useEffect(() => {
    if (!paletteOpen || allFindings.length) return;
    void api<OverviewFinding[]>("/findings")
      .then(setAllFindings)
      .catch(() => {});
  }, [paletteOpen, allFindings.length]);

  const visible = useMemo(
    () => (replayIndex !== null ? replayBoard(events, graphEvents, replayIndex) || graph : graph),
    [events, graphEvents, replayIndex, graph],
  );
  const node =
    visible &&
    (visible.facts.find((value) => value.id === selectedValue) ||
      visible.steps.find((value) => value.id === selectedValue) ||
      visible.goals.find((value) => value.id === selectedValue) ||
      visible.findings.find((value) => value.id === selectedValue) ||
      visible.hints.find((value) => value.id === selectedValue));
  const displayStep = visible?.steps.find((value) => value.id === selectedValue);
  const displayFinding = visible?.findings.find((value) => value.id === selectedValue);
  const displayFact = visible?.facts.find((value) => value.id === selectedValue);
  const sources = displayStep?.from || displayFinding?.from || [];
  const filteredAssets = graph?.assets.filter((asset) => asset.hostname.includes(query)) || [];

  function setSelected(nextId: string | null) {
    setSelectedValue(nextId);
    setSelectedNodes(nextId ? [nextId] : []);
    setSelectedFacts(nextId && visible?.facts.some((fact) => fact.id === nextId) ? [nextId] : []);
    if (nextId) {
      setHistoryTab("detail");
      const record = [
        ...(visible?.facts || []),
        ...(visible?.steps || []),
        ...(visible?.findings || []),
        ...(visible?.goals || []),
      ].find((item) => item.id === nextId);
      setFocus((previous) => ({ id: nextId, seq: (previous?.seq ?? 0) + 1 }));
    }
  }
  function selectNode(nextId: string | null, additive = false) {
    if (nextId) setHistoryTab("detail");
    const next = !nextId
      ? []
      : !additive
        ? [nextId]
        : selectedNodes.includes(nextId)
          ? selectedNodes.filter((value) => value !== nextId)
          : [...selectedNodes, nextId];
    setSelectedNodes(next);
    setSelectedValue(next.at(-1) || null);
    setSelectedFacts(next.filter((value) => visible?.facts.some((fact) => fact.id === value)));
  }
  function resizePanel(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const width = panelWidth;
    const target = event.currentTarget;
    const move = (pointer: PointerEvent) => {
      const next = Math.max(280, Math.min(680, width + start - pointer.clientX));
      setPanelWidth(next);
      writePreference("tessera.sidePanelWidth", String(next));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      setMessage("已保存");
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Page, options?: { top?: boolean; anchor?: string }) {
    rememberView();
    setTrafficTarget(null);
    if (isWorkspacePage(next)) {
      evidenceRequest.current++;
      setEvidencePreview(null);
      setEvidenceReturn(null);
      setPlaying(false);
      setFocusFinding(null);
      setPage(next);
      setId(null);
      setGraph(null);
      setEvents([]);
      eventCursor.current = 0;
      setMobileNav(false);
      history.replaceState(null, "", routeHash(null, next));
      return;
    }
    if (!id) return;
    if (options?.top || options?.anchor) {
      pageScroll.set(`${id || "workspace"}:${next}`, 0);
      pendingNavigation.current = { projectId: id, page: next, anchor: options.anchor };
      setNavigationSequence((value) => value + 1);
    }
    if (next !== page) rememberNavigation();
    if (next !== "evidence") {
      evidenceRequest.current++;
      setEvidencePreview(null);
      setEvidenceReturn(null);
    }
    if (next !== "findings") setFocusFinding(null);
    setPage(next);
    setMobileNav(false);
    history.replaceState(null, "", routeHash(id, next));
  }
  function openInGraph(scope: GraphScope) {
    rememberView();
    rememberNavigation();
    evidenceRequest.current++;
    setEvidencePreview(null);
    setEvidenceReturn(null);
    setGraphScope(scope);
    setSelectedFacts([]);
    setSelected(scope.ids[0] ?? null);
    setHistoryTab("detail");
    setReplayIndex(null);
    setPlaying(false);
    setPage("blackboard");
    if (id) history.replaceState(null, "", routeHash(id, "blackboard"));
  }
  function openProject(nextId: string, destination?: ProjectPage) {
    setTrafficTarget(null);
    if (!nextId) {
      rememberView();
      backStack.current = [];
      evidenceRequest.current++;
      setId(null);
      setGraph(null);
      setEvents([]);
      eventCursor.current = 0;
      setPage("security");
      history.replaceState(null, "", "#/security");
      return;
    }
    // Keep the origin (including a workspace page such as 漏洞库) so the
    // single topbar back button can return to it at the same scroll offset.
    if (nextId !== id) rememberNavigation();
    rememberView();
    evidenceRequest.current++;
    setEvidencePreview(null);
    setEvidenceReturn(null);
    restoringEvidence.current = null;
    setFocusFinding(null);
    if (nextId !== id) {
      sequence.current++;
      currentId.current = nextId;
      setGraph(null);
      setEvents([]);
      eventCursor.current = 0;
    }
    const target = destination || (projectViews.current.get(nextId)?.page as ProjectPage | undefined) || "overview";
    setId(nextId);
    setPage(target);
    setMobileNav(false);
    history.replaceState(null, "", routeHash(nextId, target));
  }
  function goBack() {
    setTrafficTarget(null);
    const previous = backStack.current.pop();
    if (!previous) {
      openProject("");
      return;
    }
    rememberView();
    evidenceRequest.current++;
    setEvidencePreview(null);
    setEvidenceReturn(null);
    setPlaying(false);
    pendingNavigation.current = null;
    if (previous.id !== id) {
      sequence.current++;
      currentId.current = previous.id;
      setGraph(null);
      setEvents([]);
      eventCursor.current = 0;
      restoringEvidence.current = null;
    }
    if (previous.page !== "findings") setFocusFinding(null);
    setSelected(previous.selected);
    setSelectedNodes(previous.selectedNodes);
    setSelectedFacts(previous.selectedFacts);
    setGraphScope(previous.scope);
    setHistoryTab(previous.historyTab);
    setReplayIndex(previous.replayIndex);
    setId(previous.id);
    setPage(previous.page);
    pageScroll.set(`${previous.id || "workspace"}:${previous.page}`, previous.scrollTop);
    setNavigationSequence((value) => value + 1);
    history.replaceState(null, "", routeHash(previous.id, previous.page));
  }
  async function showEvidence(item: Evidence) {
    const request = ++evidenceRequest.current;
    setEvidencePreview({ item });
    try {
      if (item.mime_type.startsWith("image/")) return;
      const response = await fetch("/api" + path(id!, `/evidence/${item.id}/content`));
      if (!response.ok) throw new Error(await response.text());
      const raw = await response.text();
      if (request !== evidenceRequest.current) return;
      setEvidencePreview({
        item,
        text: raw.length > 150000 ? raw.slice(0, 150000) + "\n…预览已截断；可下载原始内容" : raw,
      });
    } catch (failure) {
      if (request === evidenceRequest.current) setError(failure instanceof Error ? failure.message : "读取证据失败");
    }
  }
  function returnFromEvidence() {
    if (!evidenceReturn || evidenceReturn.projectId !== id) return;
    restoringEvidence.current = evidenceReturn;
    navigate(evidenceReturn.page);
  }
  const linkEvidence = (ids: string[]) =>
    ids.map((evidenceId) => {
      const item = graph?.evidence.find((value) => value.id === evidenceId);
      return item ? (
        <button
          className="evidence-link"
          key={evidenceId}
          onClick={(event) => {
            const container = document.querySelector<HTMLElement>(".content");
            const anchor = event.currentTarget.closest<HTMLElement>(".finding-card, .review-card");
            if (page !== "evidence" && id)
              setEvidenceReturn({
                projectId: id,
                page,
                scrollTop: container?.scrollTop ?? 0,
                anchorId: anchor?.id || undefined,
                offset:
                  container && anchor
                    ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
                    : undefined,
              });
            navigate("evidence");
            void showEvidence(item);
          }}
        >
          <FileText size={13} />
          {item.id} · {item.title}
          <ArrowUpRight size={11} />
        </button>
      ) : null;
    });

  function openTraffic(target: TrafficTarget) {
    navigate("traffic");
    setTrafficTarget(target);
  }

  /** 就地弹层预览一条流量：不切页、不改路由，关闭后原页面保持原样。 */
  function openTrafficPreview(target: TrafficTarget) {
    setTrafficPreview(target);
  }
  function closeTrafficPreview() {
    setTrafficPreview(null);
  }

  function openFinding(projectId: string, findingId: string) {
    setFindingSeverity("all");
    // Navigation clears the focus target; set it afterwards so a cross-project
    // click actually selects the requested Finding instead of the first row.
    if (projectId !== id) openProject(projectId, "findings");
    else navigate("findings");
    setFocusFinding({ projectId, findingId });
    setPaletteOpen(false);
  }

  async function submitModal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    if (modal === "create") {
      const result = await action(async () => {
        const created = await api<Graph>("/projects", {
          title: values.get("title"),
          origin: values.get("origin"),
          goal: values.get("goal"),
          mode: newMode,
          hints: [...values.entries()]
            .filter(([key, value]) => key.startsWith("hint_") && String(value).trim())
            .map(([, value]) => ({
              content: String(value),
              creator: localPrefs().actor_name,
            })),
        });
        openProject(created.project.id);
      });
      if (result) {
        setModal(null);
        setNewHints([""]);
        setNewMode("classic");
      }
    }
    if (modal === "rename") {
      if (await action(() => api(path(id!, "/title"), { title: values.get("title") }, "PUT"))) setModal(null);
    }
    if (modal === "reopen") {
      if (
        await action(() =>
          api(path(id!, "/reopen"), {
            description: values.get("summary"),
            creator: localPrefs().actor_name,
          }),
        )
      )
        setModal(null);
    }
    if (modal === "discard") {
      const step = graph?.steps.find((value) => value.id === selectedValue);
      if (
        step &&
        (await action(() =>
          api(path(id!, `/fgs/steps/${step.id}`), { discard: true, reason: values.get("reason") }, "PUT"),
        ))
      ) {
        setModal(null);
        setHistoryTab("detail");
      }
    }
  }

  const workspace: Workspace = {
    page,
    id,
    graph,
    visible,
    graphId,
    events,
    boardEvents: graphEvents,
    projects,
    overview,
    overviewLoading,
    allFindings,
    reviewFindings,
    config,
    theme,
    markdownRendering,
    selected: selectedValue,
    selectedNodes,
    selectedFacts,
    graphScope,
    historyTab,
    replayIndex,
    playing,
    speed,
    focus,
    panelWidth,
    query,
    checked,
    projectFilter,
    hint,
    busy,
    error,
    message,
    evidencePreview,
    findingSeverity,
    focusFinding,
    trafficTarget,
    trafficPreview,
    paletteOpen,
    refreshing,
    node,
    displayStep,
    displayFact,
    displayFinding,
    sources,
    filteredAssets,
    navigate,
    action,
    refresh,
    openProject,
    openInGraph,
    clearGraphScope: () => setGraphScope(null),
    setGraphScope,
    showEvidence,
    returnFromEvidence,
    linkEvidence,
    resizePanel,
    selectNode,
    setSelected,
    setSelectedFacts,
    setHistoryTab,
    setReplayIndex,
    setPlaying,
    setSpeed,
    setFocus,
    setPanelWidth,
    setQuery,
    setChecked,
    setProjectFilter,
    setHint,
    setEvidencePreview,
    setConfig,
    setModal,
    setMessage,
    setError,
    setFindingSeverity,
    openFinding,
    openTraffic,
    openTrafficPreview,
    closeTrafficPreview,
    clearFocusFinding: () => setFocusFinding(null),
    setPaletteOpen,
    setTheme: setThemeState,
    setMarkdownRendering,
  };

  const logout = () => {
    void authLogout().catch(() => {});
    setSession({ authenticated: false });
    setGraph(null);
    setProjects([]);
    setOverview(null);
    setAllFindings([]);
    setReviewFindings([]);
    setEvents([]);
    setSelectedValue(null);
    setError("");
  };

  const currentProject = id ? projects.find((project) => project.id === id) || null : null;
  const projectTitle = graph?.project.title || currentProject?.title;
  const counts = {
    projects: projects.length,
    findings:
      overview?.totals.confirmed ?? projects.reduce((sum, item) => sum + (item.confirmed_finding_count ?? 0), 0),
    pendingReview: reviewFindings.length,
  };

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div className="app" data-collapsed={collapsed} data-mobile-nav={mobileNav}>
        <Sidebar
          projects={projects}
          currentId={id}
          graph={graph}
          page={page}
          collapsed={collapsed}
          mobileOpen={mobileNav}
          theme={theme}
          counts={counts}
          username={session?.username}
          onNavigate={(next) => navigate(next)}
          onOpenProject={(next) => openProject(next)}
          onNew={() => setModal("create")}
          onSettings={() => navigate("settings")}
          onToggleCollapse={() => setCollapsed(!collapsed)}
          onToggleTheme={() => setThemeState(theme === "light" ? "dark" : "light")}
          onLogout={logout}
          onCloseMobile={() => setMobileNav(false)}
          onOpenProjectPicker={() => setPaletteOpen(true)}
        />
        {mobileNav && (
          <button type="button" className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />
        )}
        <div className="app-main">
          <Topbar
            page={page}
            project={currentProject}
            projectTitle={id ? projectTitle : undefined}
            refreshing={refreshing}
            onMenu={() => setMobileNav(!mobileNav)}
            onBack={() => {
              if (page === "evidence" && evidenceReturn) returnFromEvidence();
              else goBack();
              setMobileNav(false);
            }}
            onSearch={() => setPaletteOpen(true)}
            onHome={() => navigate("security")}
            onProject={() => navigate("overview")}
            actions={
              id && graph ? (
                <div className="topbar-tools" role="group" aria-label="项目全局操作">
                  <ProjectUsage graph={graph} compact />
                  {graph.project.status === "completed" ? (
                    <button
                      type="button"
                      className="icon-button topbar-tool"
                      aria-label="继续评估项目"
                      title="继续评估"
                      disabled={busy}
                      onClick={() => setModal("reopen")}
                    >
                      <RotateCcw size={15} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button topbar-tool"
                      aria-label={graph.project.status === "active" ? "暂停项目" : "继续项目"}
                      title={graph.project.status === "active" ? "暂停项目" : "继续项目"}
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api(
                            path(id, "/status"),
                            {
                              status: graph.project.status === "active" ? "stopped" : "active",
                            },
                            "PUT",
                          ),
                        )
                      }
                    >
                      {graph.project.status === "active" ? <Pause size={15} /> : <Play size={15} />}
                    </button>
                  )}
                  <ProjectExtras
                    compact
                    project={graph.project}
                    afterChange={action}
                    onRemoved={() => openProject("")}
                  />
                </div>
              ) : null
            }
          />

          <main className="content">
            {message && <Toast message={message} onClose={() => setMessage("")} />}
            {(error || loadError) && (
              <div className="banner danger" role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{error || loadError}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭提示"
                  onClick={() => {
                    setError("");
                    setLoadError("");
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {!id && page === "security" && <SecurityOverviewPage />}
            {!id && page === "vulns" && <AllFindingsPage />}
            {!id && page === "reviews" && <ReviewsPage />}
            {!id && page === "projects" && <ProjectsPage />}
            {id && graph && page === "overview" && <ProjectOverviewPage />}
            {id && graph && page === "peers" && <PeersPage />}
            {id && graph && page === "messages" && <MessagesPage />}
            {id && graph && page === "retry" && <RetryPage />}
            {id && graph && page === "findings" && <FindingsPage />}
            {id && graph && page === "review" && <ReviewPage />}
            {id && graph && page === "assets" && <AssetsPage />}
            {id && graph && page === "tasks" && <TimelinePage initialView="tasks" />}
            {id && graph && page === "timeline" && <TimelinePage />}
            {id && graph && page === "traffic" && <TrafficPage />}
            {id && graph && page === "evidence" && <EvidencePage />}
            {id && graph && page === "files" && <FilesPage />}
            {id && graph && page === "blackboard" && visible && (
              <Suspense
                fallback={
                  <div className="empty-state" role="status">
                    正在加载黑板…
                  </div>
                }
              >
                <BoardPage />
              </Suspense>
            )}
            {page === "settings" && <SettingsPage />}

            {id && !graph && !loadError && (
              <div className="page-skeleton">
                <div className="skeleton" style={{ height: 28, width: 260 }} />
                <div className="skeleton" style={{ height: 14, width: 420 }} />
                <div className="skeleton-grid">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div className="skeleton" key={index} style={{ height: 96 }} />
                  ))}
                </div>
              </div>
            )}
            {id && !graph && loadError && (
              <div className="banner danger" role="alert">
                <Ban size={15} />
                <span>{loadError}</span>
                <button type="button" className="button ghost" onClick={() => void refresh()}>
                  重试
                </button>
              </div>
            )}
          </main>
        </div>

        {evidencePreview && page !== "evidence" && (
          <Drawer label="证据预览" title={evidencePreview.item.title} onClose={() => setEvidencePreview(null)}>
            {evidencePreview.item.source_path && (
              <div className="evidence-hash">来源文件：{evidencePreview.item.source_path}</div>
            )}
            <div className="evidence-hash">SHA-256 {evidencePreview.item.sha256}</div>
            {evidencePreview.item.mime_type.startsWith("image/") ? (
              <img
                className="evidence-image"
                alt={evidencePreview.item.title}
                src={`/api${path(id!, `/evidence/${evidencePreview.item.id}/content`)}`}
              />
            ) : markdownRendering &&
              evidencePreview.text &&
              isMarkdownEvidence(evidencePreview.item, evidencePreview.text) ? (
              <div className="evidence-drawer-doc">
                <RichText text={evidencePreview.text} preserveLines />
              </div>
            ) : (
              <pre className="export-preview">{evidencePreview.text || "读取中…"}</pre>
            )}
          </Drawer>
        )}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          projects={projects}
          graph={graph}
          currentId={id}
          findings={allFindings}
          theme={theme}
          onNavigate={navigate}
          onOpenProject={(next) => openProject(next)}
          onOpenFinding={openFinding}
          onLocate={(recordId) => {
            if (id) locateRecord(workspace, recordId);
          }}
          onNew={() => setModal("create")}
          onToggleTheme={() => setThemeState(theme === "light" ? "dark" : "light")}
          onLogout={logout}
        />

        {modal === "create" && (
          <Modal
            label="新建探索项目"
            title="新建探索项目"
            busy={busy}
            onClose={() => setModal(null)}
            onSubmit={submitModal}
            footer={
              <>
                <button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? "提交中…" : "创建项目"}
                </button>
              </>
            }
          >
            <label className="field">
              <span className="field-label">项目名称</span>
              <input name="title" required autoFocus placeholder="例如：业务系统评估" />
            </label>
            <fieldset className="mode-field">
              <legend className="field-label">
                架构模式
                <small>二选一，创建后不可切换</small>
              </legend>
              <div className="mode-picker" role="radiogroup" aria-label="架构模式">
                {(["classic", "swarm"] as const).map((mode) => {
                  const info = modeLabels[mode];
                  const Icon = mode === "swarm" ? Users : Route;
                  const selected = newMode === mode;
                  return (
                    <label key={mode} className="mode-option" data-mode={mode} data-selected={selected || undefined}>
                      <input
                        type="radio"
                        name="mode"
                        value={mode}
                        checked={selected}
                        onChange={() => setNewMode(mode)}
                      />
                      <span className="mode-option-icon" aria-hidden="true">
                        <Icon size={15} />
                      </span>
                      <span className="mode-option-body">
                        <strong>{info.label}</strong>
                        <span>{info.summary}</span>
                        <em>适合：{info.fit}</em>
                      </span>
                      <span className="mode-option-check" aria-hidden="true">
                        <Check size={10} />
                      </span>
                    </label>
                  );
                })}
              </div>
              <span className="field-hint">
                {newMode === "swarm"
                  ? "默认只创建一个执行者：它按自己的方向连续探索，也可以自行裂变出同伴，通过消息协作；不需要先把目标拆成任务。"
                  : "由单一决策入口读图、定方向和拆任务，再交给执行者逐项完成；适合需要统一优先级与确定性队列的目标。"}
              </span>
            </fieldset>
            <label className="field">
              <span className="field-label">指定站点 / 起始信息</span>
              <textarea name="origin" required rows={2} placeholder="https://your-site.example" />
            </label>
            <label className="field">
              <span className="field-label">目标</span>
              <textarea name="goal" required rows={3} placeholder="希望模型完成的目标或评估范围" />
            </label>
            <div className="initial-hints">
              <div className="initial-hints-heading">
                <span>初始 Hints（可选）</span>
                <button type="button" className="button ghost small" onClick={() => setNewHints((old) => [...old, ""])}>
                  + 添加
                </button>
              </div>
              {newHints.map((value, index) => (
                <div className="initial-hint-row" key={index}>
                  <textarea
                    name={"hint_" + index}
                    aria-label={"初始 Hint " + (index + 1)}
                    value={value}
                    rows={2}
                    onChange={(event) =>
                      setNewHints((old) =>
                        old.map((item, position) => (position === index ? event.target.value : item)),
                      )
                    }
                  />
                  {newHints.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"移除初始 Hint " + (index + 1)}
                      onClick={() => setNewHints((old) => old.filter((_, position) => position !== index))}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="quiet">两种架构并行，不分新旧，共用同一套黑板、证据、审核与报告；区别只在由谁规划下一步。</p>
            <p className="quiet">发现的子域名进入待批准列表，不会自动测试。</p>
          </Modal>
        )}

        {modal === "rename" && (
          <Modal
            label="重命名项目"
            title="重命名项目"
            busy={busy}
            onClose={() => setModal(null)}
            onSubmit={submitModal}
            footer={
              <>
                <button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button className="button primary" disabled={busy}>
                  确认
                </button>
              </>
            }
          >
            <label className="field">
              <span className="field-label">项目名称</span>
              <input name="title" defaultValue={graph?.project.title} required autoFocus />
            </label>
          </Modal>
        )}

        {modal === "reopen" && (
          <Modal
            label="继续评估"
            title="继续评估"
            busy={busy}
            onClose={() => setModal(null)}
            onSubmit={submitModal}
            footer={
              <>
                <button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button className="button primary" disabled={busy}>
                  确认
                </button>
              </>
            }
          >
            <label className="field">
              <span className="field-label">继续探索的原因</span>
              <textarea name="summary" required rows={3} placeholder="新信息或需要继续验证的方向" />
            </label>
          </Modal>
        )}

        {modal === "discard" && (
          <Modal
            label="废弃这个方向"
            title="废弃这个方向"
            busy={busy}
            onClose={() => setModal(null)}
            onSubmit={submitModal}
            footer={
              <>
                <button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button className="button danger" disabled={busy}>
                  确认废弃
                </button>
              </>
            }
          >
            <p className="quiet">{graph?.steps.find((step) => step.id === selectedValue)?.description}</p>
            <label className="field">
              <span className="field-label">废弃理由</span>
              <textarea
                name="reason"
                required
                rows={3}
                autoFocus
                placeholder="为何放弃这个方向：条件不成立、重复路径、证据否定…"
              />
            </label>
          </Modal>
        )}

        {trafficPreview && id && (
          <TrafficPreviewModal
            project={id}
            flowId={trafficPreview.flowId}
            label={trafficPreview.label || trafficPreview.findingId}
            onClose={closeTrafficPreview}
          />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
