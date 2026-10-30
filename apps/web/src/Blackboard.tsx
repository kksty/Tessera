import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import { Boxes, Download, GitBranch, Maximize, Minus, Network, Plus, Route, Sparkles } from "lucide-react";
import { graphMotionEnabled, installGraphMotion } from "./graph-motion.js";
import { writePreference } from "./preferences.js";
import type { Graph } from "../../../packages/protocol/src/index.js";
import { resolveGraphRelations, walkRelations } from "../../../packages/protocol/src/graph-relations.js";
import { unmetDependencies } from "../../../packages/protocol/src/step-chain.js";
import { activeGraph } from "../../../packages/protocol/src/node-lifecycle.js";
import { applyLayout, layoutOptions, localPrefs, raiseToReadableZoom } from "./layouts.js";
import { boardViewports, type BoardViewport } from "./view-state.js";
import { coldNodes, isColdNode } from "./coldness.js";
import { chainElements, SCOPE_FULL, scopeSeeds, scopeSize, type GraphScope } from "./graph-scope.js";
import { domainSummaryElements, summaryElements, TYPE_LABEL } from "./graph-summary.js";
import { fitNodeLabel, NODE_LINE_HEIGHT, NODE_MIN_HEIGHT, NODE_TEXT_PADDING } from "./label-fit.js";

cytoscape.use(dagre);

const FONT =
  '"Geist", "Source Sans 3", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

const NODE_TEXT_WIDTH: Record<string, number> = {
  origin: 132,
  goal: 148,
  subgoal: 124,
  scope: 134,
  fact: 136,
  finding: 130,
  hint: 132,
  step: 168,
};
const NODE_MAX_LINES = 6;

/** 滚轮一格（deltaY ≈ 100）的缩放倍率；触控板的小 delta 按比例缩小。 */
const WHEEL_STEP = 1.35;
const MAX_VIEWPORTS = 48;

/** 画布主题色板：只在 data-theme 变化时重建，避免每次渲染改写样式表。 */
type Palette = Record<string, Record<string, string>>;
let cachedTheme = "";
let cachedPalette: Palette | null = null;

function readPalette(): Palette {
  const theme = document.documentElement.dataset.theme || "light";
  if (cachedPalette && cachedTheme === theme) return cachedPalette;
  const css = getComputedStyle(document.documentElement);
  const c = (name: string) => css.getPropertyValue(name).trim();
  const palette: Palette = {
    node: {
      "background-color": c("--bg-elev"),
      color: c("--text-2"),
      "border-color": c("--border-strong"),
    },
    origin: {
      "background-color": c("--accent"),
      color: c("--accent-contrast"),
      "border-color": c("--accent"),
    },
    goal: {
      "background-color": c("--bg-elev"),
      color: c("--success"),
      "border-color": c("--success"),
    },
    subgoal: {
      "background-color": c("--bg-elev"),
      color: c("--info"),
      "border-color": c("--info"),
    },
    scopeNode: {
      "background-color": c("--board-scope-soft"),
      color: c("--board-scope"),
      "border-color": c("--board-scope"),
    },
    fact: {
      "background-color": c("--bg-elev"),
      "border-color": c("--info"),
      color: c("--text"),
    },
    finding: {
      "background-color": c("--bg-elev"),
      color: c("--warn"),
      "border-color": c("--warn"),
    },
    navigation: {
      "background-color": c("--surface-2"),
      color: c("--muted"),
      "border-color": c("--border-strong"),
    },
    step: {
      "background-color": c("--surface-2"),
      "border-color": c("--faint"),
      color: c("--muted"),
    },
    stepRunning: {
      "background-color": c("--bg-elev"),
      "border-color": c("--motion-accent"),
      color: c("--text"),
      "underlay-color": c("--motion-accent"),
    },
    stepDone: {
      "background-color": c("--bg-elev"),
      "border-color": c("--info"),
      color: c("--info"),
    },
    stepBlocked: {
      "background-color": c("--surface-2"),
      "border-color": c("--warn"),
      color: c("--warn"),
    },
    frame: {
      "background-color": c("--surface-4"),
      "border-color": c("--line-strong"),
      color: c("--text"),
    },
    summary: {
      "background-color": c("--surface-2"),
      "border-color": c("--border-strong"),
      color: c("--text"),
    },
    edge: {
      "line-color": c("--border-strong"),
      "target-arrow-color": c("--border-strong"),
      color: c("--muted"),
      "text-background-color": c("--bg-elev"),
    },
    // 绿色（--success）在整个黑板上只代表「唯一的最终目标」；已完成的探索用冷色表示，
    // 否则满屏的绿色会让真正需要一眼认出的目标失效。
    concluded: { "line-color": c("--info"), "target-arrow-color": c("--info") },
    running: {
      "line-color": c("--motion-accent"),
      "target-arrow-color": c("--motion-accent"),
      color: c("--motion-accent"),
    },
    scope: {
      "line-color": c("--board-scope"),
      "target-arrow-color": c("--board-scope"),
      color: c("--board-scope"),
    },
    highlight: { "border-color": c("--board-selection") },
  };
  cachedTheme = theme;
  cachedPalette = palette;
  return palette;
}

function applyPalette(c: Core) {
  const p = readPalette();
  c.style()
    .selector("node")
    .style({ ...p.node, "font-weight": "normal" })
    .selector('node[type="origin"]')
    .style({ ...p.origin, "font-weight": "bold" })
    .selector('node[type="goal"]')
    .style({ ...p.goal, "font-weight": "bold" })
    // 绿色（--success）只属于「唯一最终目标」，以及它已经在达成后被连线的那一刻。
    .selector('node[type="goal"][state="open"]')
    .style({ "border-style": "dashed", "border-width": 2, color: p.node.color, "border-color": p.edge["line-color"] })
    .selector('node[type="goal"][state="achieved"]')
    .style({ "border-style": "solid", "border-width": 2, ...p.goal, "font-weight": "bold" })
    .selector('node[type="scope"]')
    .style({ ...p.scopeNode, "font-weight": 600, "border-style": "solid" })
    .selector('node[type="fact"]')
    .style(p.fact)
    .selector('node[type="subgoal"]')
    .style(p.subgoal)
    .selector('node[type="finding"]')
    .style(p.finding)
    .selector('node[type="navigation"]')
    .style(p.navigation)
    .selector('node[type="hint"]')
    .style({ ...p.subgoal, "border-style": "dashed" })
    .selector('node[type="step"]')
    .style(p.step)
    .selector('node[type="step"][state="running"]')
    .style({ ...p.stepRunning, "underlay-padding": 8, "border-style": "solid" })
    .selector('node[type="step"][state="done"]')
    .style({ ...p.stepDone, "border-style": "solid" })
    // 等待前置的任务用虚线警示边框：节点本身还没有可执行的结果。
    .selector('node[type="step"][blocked="yes"]')
    .style({ ...p.stepBlocked, "border-style": "dashed", "border-width": 1.5 })
    .selector('node[type="step"][expanded=1]')
    .style({ color: p.node.color })
    // 汇总节点：虚线框表示「这是一类节点的合并」，边框色沿用该类节点，数量写在标签里。
    .selector('node[type="summary"]')
    .style({ ...p.summary, "font-weight": 600, "border-style": "dashed", "border-width": 1.5 })
    .selector('node[type="summary"][groupType="origin"]')
    .style({ "border-color": p.origin["border-color"] })
    .selector('node[type="summary"][groupType="goal"]')
    .style({ "border-color": p.goal["border-color"] })
    .selector('node[type="summary"][groupType="subgoal"]')
    .style({ "border-color": p.subgoal["border-color"] })
    .selector('node[type="summary"][groupType="scope"]')
    .style({ "border-color": p.scopeNode["border-color"] })
    .selector('node[type="summary"][groupType="fact"]')
    .style({ "border-color": p.fact["border-color"] })
    .selector('node[type="summary"][groupType="step"]')
    .style({ "border-color": p.step["border-color"] })
    .selector('node[type="summary"][groupType="finding"]')
    .style({ "border-color": p.finding["border-color"] })
    .selector('node[type="summary"][groupType="hint"]')
    .style({ "border-color": p.subgoal["border-color"] })
    // 测试域卡片：框本身不接收点击，真实节点才可选中；标题居中靠上，给框里的节点留出空间。
    .selector('node[type="summary"][frame=1]')
    .style({
      ...p.frame,
      width: "data(width)",
      height: "data(height)",
      "text-max-width": "data(labelWidth)",
      // cytoscape 的 text-valign: top 会把标签放到框外；这里用居中 + 每张卡自己的
      // 负偏移，把标题块挪到框内预留的 header 区域。
      "text-valign": "center",
      "text-halign": "center",
      "text-margin-y": (el: any) => Number(el.data("labelOffsetY")) || 0,
      "font-size": 16.5,
      "line-height": 1.35,
      // 域标题是缩略图里唯一还能读的层级；比节点文字多保留一点可读缩放范围。
      "min-zoomed-font-size": 4,
      "background-opacity": 0.65,
      "border-width": 2.5,
      "border-style": "dashed",
      "corner-radius": "10px",
      "z-index": 0,
      events: "no",
    })
    // 框里的真实节点用紧凑卡片，不再按任务圆圈或长事实框绘制。
    .selector("node.grouped")
    .style({
      shape: "round-rectangle",
      width: 168,
      height: "data(height)",
      "font-size": 12.5,
      "font-weight": 400,
      "text-max-width": "148px",
      "border-width": 1,
      "border-style": "solid",
      "corner-radius": "6px",
      "z-index": 1,
    })
    .selector("edge")
    .style({ ...p.edge, "text-background-opacity": 0.9 })
    .selector('edge[type="summary"]')
    .style({
      width: 1.8,
      "font-size": 14,
      // 域分框初始缩略到整图可见；字号不够大时「N 条关联」会被 min-zoomed-font-size 整块藏掉。
      "min-zoomed-font-size": 4,
      "font-weight": 600,
      // 汇总边常是竖直的，autorotate 会把「N 条关联」竖排；总览层统一横排。
      "text-rotation": "none",
      // 两个汇总框之间可能同时有正向和反向关联；弯曲方向相反，标签才不会叠在一起。
      "curve-style": "unbundled-bezier",
      "control-point-distances": 72,
      "control-point-weights": 0.5,
    })
    .selector('edge[status="concluded"]')
    .style(p.concluded)
    .selector('edge[status="running"]')
    .style({ ...p.running, "text-background-color": p.edge["text-background-color"] })
    .selector('edge[status="finding"]')
    .style({
      "line-color": p.finding["border-color"],
      "target-arrow-color": p.finding["border-color"],
      color: p.finding["border-color"],
    })
    .selector('edge[status="scope-approval"]')
    .style(p.scope)
    .selector('edge[status="concluded"][target="goal"]')
    .style({ "line-color": p.goal["border-color"], "target-arrow-color": p.goal["border-color"] })
    .selector("node.selected, node.selected-fact")
    .style({
      ...p.highlight,
      "border-width": 2,
      "outline-color": p.highlight["border-color"],
      "outline-width": 1.5,
      "outline-offset": 3,
      "underlay-color": p.highlight["border-color"],
      "underlay-padding": 6,
      "underlay-opacity": 0.08,
    })
    .selector("edge.selected")
    .style({
      "line-color": p.highlight["border-color"],
      "target-arrow-color": p.highlight["border-color"],
      width: 2,
    })
    .update();
}

/**
 * 事实节点先回答「它断言了什么」：有结论就画结论，没有才回退观测正文。
 *
 * conclusion 是 ≤120 字、投影里从不截断的断言字段；description 是观测正文（常常从
 * 「目的：…」这类执行意图写起）。画布上用正文会让同一任务产出的多条事实第一行雷同，
 * 扫图读不出差别。结论由正文推断而来时加前缀，避免把程序补的摘要当成实测断言；
 * 起点保留原文，它本来就只有一个地址。
 */
function factLabel(fact: Graph["facts"][number]): string {
  if (fact.id === "origin") return `起点\n${fact.description}`;
  const conclusion = fact.conclusion?.trim();
  if (!conclusion) return fact.description;
  return fact.conclusion_inferred ? `推断 · ${conclusion}` : conclusion;
}

export function graphElements(g: Graph, graphId: string, expandSteps = false): ElementDefinition[] {
  g = activeGraph(g);
  const relations = resolveGraphRelations(g);
  const ancestry = walkRelations(
    relations,
    [...g.steps, ...g.facts, ...g.findings].filter((record) => record.graph_id === graphId).map((record) => record.id),
    "sources",
  );
  const steps = g.steps.filter((s) => s.graph_id === graphId || ancestry.depths.has(s.id));
  const outputs = (id: string) =>
    (relations.downstream.get(id) ?? []).filter((edge) => edge.kind === "fact_production").map((edge) => edge.target);
  /* 范围节点：人工批准一个子域名/站点时写入的事实（带 asset_id），它没有生产者——
     它来自人的授权，不是某次探索的结论。挂在 origin 下作为「范围」节点，而不是假装它是发现。 */
  const produced = new Set([...relations.facts].filter(([, source]) => source.producers.length).map(([id]) => id));
  const scopeFact = (f: Graph["facts"][number]) => !!f.asset_id && !produced.has(f.id) && f.id !== "origin";
  const facts = g.facts.filter(
    (f) => f.id === "origin" || f.graph_id === graphId || ancestry.depths.has(f.id) || scopeFact(f),
  );
  // Goal 的达成只由存储状态决定；不要把旧归档 Step 当成当前目标状态，
  // 项目“继续评估”复位根目标后，黑板必须跟着复位。
  const achieved = g.goals.find((v) => v.id === "goal")?.state === "satisfied";
  const nodes: ElementDefinition[] = [
    ...g.hints
      .filter((h) => !h.withdrawn_at)
      .map((h) => ({
        data: { id: h.id, label: `${h.id} · ${h.content}`, type: "hint", state: "active" },
      })),
    ...facts.map((f) => ({
      data: {
        id: f.id,
        label: factLabel(f),
        type: f.id === "origin" ? "origin" : scopeFact(f) ? "scope" : "fact",
        state: f.status || "observation",
        cold: isColdNode(g, f) ? "yes" : "no",
      },
    })),
    ...g.goals
      .filter((v) => v.id === "goal" || v.graph_id === graphId)
      .map((v) => ({
        data: {
          id: v.id,
          label: v.id === "goal" ? `目标\n${v.description}` : v.description,
          type: v.id === "goal" ? "goal" : "subgoal",
          // 未达成前目标不连任何线：用边框虚实表达「还没达成」，而不是画一条虚线假装因果。
          state: v.id === "goal" ? (achieved ? "achieved" : "open") : v.state,
        },
      })),
    ...steps
      .filter((s) => expandSteps || !s.concluded_at || s.discarded || (!outputs(s.id).length && s.to !== "goal"))
      .map((s) => ({
        data: {
          id: s.id,
          label: "?",
          type: "step",
          expanded: 0,
          description: s.description,
          blocked: unmetDependencies(g, s).length ? "yes" : "no",
          state: s.discarded
            ? "discarded"
            : s.concluded_at
              ? "done"
              : s.executed_at
                ? "executed"
                : s.worker
                  ? "running"
                  : "open",
        },
      })),
    ...g.findings
      .filter((v) => v.graph_id === graphId)
      .map((f) => ({
        data: {
          id: f.id,
          label: f.title,
          type: "finding",
          state: f.review_status,
          cold: isColdNode(g, f) ? "yes" : "no",
        },
      })),
  ];
  for (const node of nodes) {
    const text = String(node.data.label || "");
    const type = String(node.data.type || "fact");
    const maxWidth = NODE_TEXT_WIDTH[type] || 112;
    const fitted = fitNodeLabel(text, maxWidth, NODE_MAX_LINES);
    node.data.label = fitted.label;
    node.data.height = Math.max(NODE_MIN_HEIGHT, fitted.lines * NODE_LINE_HEIGHT + NODE_TEXT_PADDING);
  }
  const present = new Set(nodes.map((n) => String(n.data.id))),
    edges: ElementDefinition[] = [];
  const connect = (source: string, target: string, status: string, stepId?: string, label = "", type = "flow") => {
    if (source !== target && present.has(source) && present.has(target))
      edges.push({
        data: {
          id: `${stepId || type}:${source}:${target}`,
          source,
          target,
          status,
          step_id: stepId,
          label,
          type,
        },
      });
  };
  for (const s of steps) {
    const factIds = outputs(s.id);
    const status = s.discarded ? "discarded" : s.concluded_at ? "concluded" : s.worker ? "running" : "open";
    for (const hintId of s.hint_ids || []) {
      const targets = present.has(s.id) ? [s.id] : s.to === "goal" ? ["goal"] : factIds;
      for (const target of targets) connect(hintId, target, "hint", s.id, "提示关联", `hint-${hintId}`);
    }
    if (!expandSteps && s.concluded_at && !s.discarded && (factIds.length || s.to === "goal")) {
      for (const source of s.from)
        for (const target of s.to === "goal" ? ["goal"] : factIds) connect(source, target, "concluded", s.id, s.id);
    } else {
      for (const source of s.from) connect(source, s.id, status, s.id, expandSteps ? "" : s.id);
      for (const target of factIds) connect(s.id, target, status, s.id);
      // 只有真正达成目标的 Step 才连到 Goal。未达成的方向只画到它自己的 Step 为止，
      // 不再用虚线连向 Goal —— 虚线会让「还没发生的事」看起来像一条因果证据。
      if (s.concluded_at && s.to === "goal") connect(s.id, "goal", status, s.id);
    }
  }
  for (const f of g.findings.filter((v) => v.graph_id === graphId)) {
    for (const edge of relations.upstream.get(f.id) ?? []) {
      if (edge.kind === "finding_source") connect(edge.source, f.id, "finding", undefined, "来源事实", "finding-link");
      if (edge.kind === "finding_production") {
        if (present.has(edge.source)) connect(edge.source, f.id, "finding", undefined, "产出发现", "finding-link");
        else
          for (const source of g.steps.find((s) => s.id === edge.source)?.from ?? [])
            connect(source, f.id, "finding", edge.source, "产出发现", "finding-link");
      }
    }
  }
  // 已批准的范围节点与 Origin 同层：它们是人的授权，不是探索的产出。
  for (const f of facts.filter(scopeFact))
    connect("origin", f.id, "scope-approval", undefined, "批准范围", "scope-link");
  return [...nodes, ...edges];
}

/** 发现链路只在当前活动图上展开真实任务节点；目标意向线不冒充发现的因果证据。 */
export function discoveryElements(graph: Graph): ElementDefinition[] {
  return graphElements(graph, "main", true).filter((element) => element.data.type !== "goal-link");
}

function rememberViewport(key: string, viewport: BoardViewport) {
  boardViewports.set(key, viewport);
  // 回放会为每条事件生成一个范围键，条数要有上界，避免长时间回放把内存堆满。
  while (boardViewports.size > MAX_VIEWPORTS) {
    const oldest = boardViewports.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    boardViewports.delete(oldest);
  }
}

export function Blackboard({
  graph,
  graphId,
  selected,
  selectedFacts = [],
  selectedNodes = [],
  focus = null,
  scope = null,
  onSelect,
  onInspect,
  onClearScope,
  deciding = false,
  replaying = false,
}: {
  graph: Graph;
  graphId: string;
  selected: string | null;
  selectedFacts?: string[];
  selectedNodes?: string[];
  focus?: { id: string; seq: number } | null;
  scope?: GraphScope | null;
  onSelect: (id: string | null, additive?: boolean) => void;
  onInspect?: (id: string) => void;
  onClearScope?: () => void;
  deciding?: boolean;
  replaying?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null),
    particles = useRef<HTMLCanvasElement>(null),
    cy = useRef<Core | null>(null),
    callback = useRef(onSelect),
    inspectCallback = useRef(onInspect);
  callback.current = onSelect;
  inspectCallback.current = onInspect;
  // 初次渲染就要用对布局：否则「挂载时已经是链路视图」会先按偏好布局跑一遍，
  // 再被自动切换打断，节点位置与缓存视角对不上，往返页面就丢视角。
  const initialScoped = scopeSeeds(scope).length > 0;
  const [layout, setLayout] = useState(() => (initialScoped ? "dagre_tb" : localPrefs().layout_mode)),
    layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [layoutError, setLayoutError] = useState("");
  const [motion, setMotion] = useState(graphMotionEnabled);
  // 0 = 完整链路（一路追到起点与结论）；1–3 = 只追这么多跳
  const [hops, setHops] = useState(SCOPE_FULL);
  // 汇总视图：按测试域分框（默认，大图先看域）或按节点类型合并成少量框；
  // 类型视图可展开一个组恢复原节点，域视图本身就把真实节点放在框里。
  // 视图模式按「项目 + 图」持久化：切去其他页面再回来要保持原样。
  const summaryKey = `tessera.summaryView:${graph.project.id}:${graphId}`;
  const readSummaryPref = (): "off" | "domain" | "type" | null => {
    try {
      const value = localStorage.getItem(summaryKey);
      if (value === "off" || value === "domain" || value === "type") return value;
    } catch {
      /* localStorage 不可用时只用默认值 */
    }
    return null;
  };
  const saveSummaryPref = (on: boolean, mode: "domain" | "type") => {
    try {
      localStorage.setItem(summaryKey, on ? mode : "off");
    } catch {
      /* 忽略写入失败 */
    }
  };
  const defaultSummary = graph.steps.length + graph.facts.length + graph.findings.length > 40;
  const [summary, setSummary] = useState(() => {
    const stored = readSummaryPref();
    return stored ? stored !== "off" : defaultSummary;
  });
  const [summaryMode, setSummaryMode] = useState<"domain" | "type">(() =>
    readSummaryPref() === "type" ? "type" : "domain",
  );
  // 换项目/换图时恢复该图自己的视图模式
  useEffect(() => {
    const stored = readSummaryPref();
    setSummary(stored ? stored !== "off" : defaultSummary);
    setSummaryMode(stored === "type" ? "type" : "domain");
  }, [summaryKey]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layoutSequence = useRef(0),
    interactionAt = useRef(0),
    layingOut = useRef(false);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  // 链路视图要「看到整条线」，所以不做聚焦居中，只做适应窗口
  const scopeActive = useRef(false);
  const summaryRef = useRef(false);
  const summaryModeRef = useRef(summaryMode);
  summaryModeRef.current = summaryMode;
  /** 域分框的整图通常比视口大；这里以「看全所有域」为先，不强行抬到可读字号。 */
  const domainBoard = () => summaryRef.current && summaryModeRef.current === "domain";
  const expandedRef = useRef<string[]>([]);
  const groupTap = useRef<(type: string) => void>(() => {});
  groupTap.current = (type) => {
    if (!type) {
      setExpanded([]);
      return;
    }
    setExpanded((prev) => (prev.includes(type) ? prev.filter((value) => value !== type) : [...prev, type]));
  };

  /** 画布上真正要画的东西：全图，或「只看这条链路」。
   *  主视图里点选只做选中，不改变范围 —— 范围只由显式 jump（发现 / 证据 / 回放 / 详情面板）决定。
   *  依赖用字符串键而不是数组：否则每次渲染都会得到新的 seeds → elements，
   *  元素集合「看起来变了」，就会在无关的重渲染里重新布局、把视角和位置冲掉。 */
  const seedsKey = (scope?.ids ?? []).join(",");
  useEffect(() => setHops(SCOPE_FULL), [seedsKey]);
  const seeds = useMemo(() => scopeSeeds(scope), [seedsKey]);
  const scoped = seeds.length > 0;
  const summaryOn = summary && !scoped;
  summaryRef.current = summaryOn;
  expandedRef.current = expanded;
  const baseElements = useMemo(() => {
    const all = seeds.length ? discoveryElements(graph) : graphElements(graph, graphId);
    return seeds.length ? chainElements(all, seeds, hops) : all;
  }, [graph, graphId, seeds, hops]);
  const elements = useMemo(
    () =>
      summaryOn
        ? summaryMode === "domain"
          ? domainSummaryElements(baseElements, graph)
          : summaryElements(baseElements, expanded)
        : baseElements,
    [baseElements, summaryOn, summaryMode, graph, expanded],
  );
  // 换图或进出链路视图时收起分组，避免把上一个视图的展开状态带过来。
  useEffect(() => setExpanded([]), [graphId, scoped]);
  const elementSignature = useMemo(
    () =>
      elements
        .map((el) => `${el.data.id}:${el.data.source || ""}:${el.data.target || ""}`)
        .sort()
        .join(","),
    [elements],
  );
  const counts = useMemo(() => scopeSize(elements), [elements]);
  scopeActive.current = scoped;
  const typeOf = (id: string) =>
    TYPE_LABEL[String((elements.find((el) => String(el.data.id) === id)?.data as { type?: string })?.type || "")] || "";
  const scopeLabel = scope?.label || (seeds[0] ? `${typeOf(seeds[0])} ${seeds[0]}`.trim() : "");
  const scopeSignature = scoped ? `${hops}:${[...seeds].sort().join("|")}` : "all";
  // 展开/收起分组会改变整张图的规模，必须换视角键并重新 fit；否则新增节点会落在当前视野之外。
  const summarySignature = summaryOn ? `summary:${summaryMode}:${[...expanded].sort().join("+") || "all"}` : "full";
  const viewportKey = `${graph.project.id}:${graphId}:${replaying ? "history" : "live"}:${scopeSignature}:${summarySignature}:nodes-v4`;
  const lastViewportKey = useRef("");
  const lastElements = useRef<string | null>(null);
  const restoreViewport = useRef<BoardViewport | undefined>(undefined);
  const appliedFocus = useRef(0),
    focusRef = useRef(focus);
  focusRef.current = focus;

  function saveViewport() {
    const c = cy.current;
    if (!c || !lastViewportKey.current || !c.nodes().length) return;
    rememberViewport(lastViewportKey.current, {
      zoom: c.zoom(),
      width: c.width(),
      height: c.height(),
      pan: { ...c.pan() },
      positions: Object.fromEntries(c.nodes().map((n) => [n.id(), { ...n.position() }])),
      // 域分框使用固定位置，缓存键必须和实际布局一致；否则往返页面会被误判为换布局。
      layout: domainBoard() ? "preset" : layoutRef.current,
      focusSeq: appliedFocus.current,
      elementSignature: lastElements.current ?? "",
    });
  }
  function applyFocus() {
    const c = cy.current,
      target = focusRef.current;
    if (!c || !target || target.seq <= appliedFocus.current || !container.current?.dataset.layoutReady) return;
    const node = c.getElementById(target.id).union(c.edges().filter((e) => e.data("step_id") === target.id));
    if (!node.length) return;
    appliedFocus.current = target.seq;
    c.stop();
    if (node.nodes().length)
      c.animate({
        center: { eles: node },
        zoom: Math.max(0.85, Math.min(1.4, c.zoom())),
        duration: 220,
        easing: "ease-out",
      });
    else c.animate({ fit: { eles: node.connectedNodes(), padding: 80 }, duration: 220, easing: "ease-out" });
  }

  function restoreCamera(c: Core, saved: BoardViewport) {
    if (
      saved.width !== undefined &&
      saved.height !== undefined &&
      (Math.abs(saved.width - c.width()) > 24 || Math.abs(saved.height - c.height()) > 24)
    ) {
      c.fit(undefined, 65);
      if (!domainBoard()) raiseToReadableZoom(c);
    } else {
      c.zoom(saved.zoom);
      c.pan(saved.pan);
    }
  }

  useEffect(() => {
    if (!container.current) return;
    const c = cytoscape({
      container: container.current,
      elements: [],
      minZoom: 0.15,
      maxZoom: 3,
      // 缩放由下面的 wheel 处理：一格一个明确的倍率，而不是浏览器的连续小步
      userZoomingEnabled: false,
      autounselectify: true,
      boxSelectionEnabled: false,
      // 拖动节点与画布时实时绘制，保留连线与文字；仅暂停装饰动效。
      hideEdgesOnViewport: false,
      textureOnViewport: false,
      motionBlur: false,
      pixelRatio: "auto",
      style: [
        {
          // 指针按下/拖动时 cytoscape 默认会在核心层画一个黑色活动圆；这里彻底关掉。
          selector: "core",
          style: { "active-bg-opacity": 0, "active-bg-size": 0 },
        },
        {
          selector: "node",
          style: {
            "background-color": "#ffffff",
            "overlay-opacity": 0,
            "border-width": 1,
            "border-color": "#e0e3f0",
            label: "data(label)",
            "font-size": 13,
            "font-weight": 500,
            "font-family": FONT,
            "line-height": 1.22,
            "text-wrap": "wrap",
            "text-max-width": "112px",
            "text-overflow-wrap": "anywhere",
            "text-valign": "center",
            "text-halign": "center",
            // 缩得太小时不画文字：这是画布上最贵的一段渲染
            "min-zoomed-font-size": 5,
            color: "#454a63",
            width: 164,
            height: "data(height)",
            shape: "round-rectangle",
            "corner-radius": 8,
          },
        },
        {
          selector: 'node[type="navigation"]',
          style: { "border-style": "dashed" },
        },
        {
          // Cold = used and quiet. Grey + dashed + translucent, never hidden: it is still readable.
          selector: 'node[cold = "yes"]',
          style: { opacity: 0.55, "border-style": "dashed", "border-color": "#c6cbdc", "background-color": "#f4f5fb" },
        },
        {
          selector: 'node[type="origin"]',
          style: { "font-size": 13, "font-weight": 600, width: 164, "corner-radius": 7, "text-max-width": 132 },
        },
        {
          selector: 'node[type="goal"]',
          style: { "font-size": 13, "font-weight": 600, width: 180, "corner-radius": 8, "text-max-width": 148 },
        },
        {
          selector: 'node[type="subgoal"]',
          style: { "font-weight": 600, width: 156, "corner-radius": 8, "text-max-width": 124 },
        },
        {
          selector: 'node[type="scope"]',
          style: { "font-weight": 600, width: 166, "corner-radius": 8, "border-width": 1.5, "text-max-width": 134 },
        },
        { selector: 'node[type="fact"]', style: { width: 168, "text-max-width": 136 } },
        {
          selector: 'node[type="finding"]',
          style: { "font-weight": 600, width: 162, "corner-radius": 8, "text-max-width": 130 },
        },
        {
          selector: 'node[type="hint"]',
          style: { width: 164, "text-max-width": 132 },
        },
        {
          selector: 'node[type="step"]',
          style: {
            shape: "ellipse",
            width: 22,
            height: 22,
            "font-size": 14,
            "font-weight": 700,
            "border-width": 1.5,
            "border-style": "dashed",
          },
        },
        {
          selector: 'node[type="step"][state="running"]',
          style: { width: 28, height: 28, "border-width": 2, "border-style": "solid" },
        },
        {
          selector: 'node[type="step"][state="done"]',
          style: { width: 24, height: 24, "border-style": "solid" },
        },
        {
          selector: 'node[type="step"][expanded=1]',
          style: {
            shape: "round-rectangle",
            width: 196,
            height: "data(height)",
            "font-size": 13,
            "font-weight": 500,
            "border-style": "solid",
            "border-width": 1,
            "corner-radius": 6,
            "text-max-width": 168,
          },
        },
        {
          // 汇总节点比普通节点宽：一行写类型和数量，有组内连线时第二行说明。
          selector: 'node[type="summary"]',
          style: {
            shape: "round-rectangle",
            width: 188,
            height: "data(height)",
            "font-size": 13,
            "font-weight": 600,
            "text-max-width": 164,
            "border-width": 1.5,
            "border-style": "dashed",
            "corner-radius": 9,
          },
        },
        {
          // 测试域框要放下「任务 / 事实 / 发现」和 post 的前缀分布，比类型框更宽。
          selector: 'node[type="summary"][summaryKind]',
          style: { width: 196, "text-max-width": "172px", "border-width": 2 },
        },
        {
          selector: 'node[type="summary"][summaryKind="focus"]',
          style: { width: 180, "text-max-width": "156px", "border-width": 1 },
        },
        { selector: 'node[state="discarded"],node[state="disputed"]', style: { opacity: 0.55 } },
        {
          selector: "edge",
          style: {
            width: 1.2,
            "line-color": "#d8dbe9",
            "target-arrow-color": "#d8dbe9",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.75,
            label: "data(label)",
            "font-size": 10,
            "font-family": FONT,
            "min-zoomed-font-size": 6,
            color: "#626880",
            "text-rotation": "autorotate",
            "text-margin-y": -8,
            "text-max-width": "92px",
            "text-wrap": "ellipsis",
            "text-events": "yes",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: 'edge[type="flow"]',
          // 低倍率下先收起流程边的长说明，只保留提示/范围/发现等短标记；放大后自然出现。
          style: { "min-zoomed-font-size": 7 },
        },
        {
          selector: 'edge[type="summary"]',
          // 合并后的边只表达「两类节点之间有多少联系」，数量就是标签。
          style: { width: 1.8, "font-weight": 600 },
        },
        {
          selector: 'edge[status="concluded"]',
          style: { width: 1.6, "line-color": "#2a6f97", "target-arrow-color": "#2a6f97" },
        },
        {
          selector: 'edge[status="running"]',
          style: {
            width: 1.6,
            "line-color": "#6353dc",
            "target-arrow-color": "#6353dc",
            "line-style": "dashed",
            "line-dash-pattern": [7, 4],
            color: "#6353dc",
          },
        },
        {
          selector: 'edge[status="open"]',
          style: { "line-style": "dashed", "line-dash-pattern": [4, 4] },
        },
        {
          selector: 'edge[status="scope-approval"]',
          style: {
            "line-style": "solid",
            "line-color": "#6a4fd0",
            "target-arrow-color": "#6a4fd0",
            color: "#6a4fd0",
            width: 1.2,
          },
        },
        {
          selector: 'edge[status="finding"]',
          style: {
            "line-color": "#8a6418",
            "target-arrow-color": "#8a6418",
            "line-style": "dotted",
          },
        },
        { selector: 'edge[status="discarded"]', style: { "line-style": "dotted", opacity: 0.55 } },
        { selector: 'edge[status="hint"]', style: { "line-style": "dashed", "target-arrow-shape": "none" } },
        { selector: "node.selected-fact", style: { "z-index": 1001 } },
      ] as any,
    });
    cy.current = c;
    applyPalette(c);
    const themeObserver = new MutationObserver(() => applyPalette(c));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const stopMotion = installGraphMotion(c, () => motionRef.current, particles.current || undefined);
    c.on("pan zoom grab drag free", () => {
      if (!layingOut.current) interactionAt.current = performance.now();
    });
    const refreshFonts = () => {
      if (!c.destroyed()) c.style().update();
    };
    void document.fonts.ready.then(refreshFonts);
    c.on("tap", "node", (e) => {
      // 域框只是容器，不是图里的节点；点框不选中、不打开详情。
      if (e.target.data("frame")) return;
      const group = e.target.data("groupType");
      if (group && summaryRef.current) {
        groupTap.current(String(group));
        return;
      }
      callback.current(e.target.id(), !!e.originalEvent?.shiftKey);
    });
    c.on("dbltap", "node", (e) => {
      // 域框不是可查看节点；双击框不应把容器 id 当成节点打开详情。
      if (e.target.data("frame")) return;
      inspectCallback.current?.(e.target.id());
    });
    c.on("tap", "edge", (e) => {
      if (e.target.data("step_id")) callback.current(e.target.data("step_id"));
    });
    c.on("tap", (e) => {
      if (e.target === c) {
        // 汇总视图里点空白先收起分组，再清空选中；不改变画布范围。
        if (summaryRef.current && expandedRef.current.length) groupTap.current("");
        callback.current(null);
      }
    });

    /** 一格滚轮 = 一个明确的倍率，并锚定在指针位置。 */
    const onWheel = (event: WheelEvent) => {
      if (c.destroyed() || (event.ctrlKey === false && event.metaKey)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const pixels = event.deltaY * unit;
      if (!pixels) return;
      const notches = Math.max(-3, Math.min(3, pixels / 100));
      const level = Math.max(c.minZoom(), Math.min(c.maxZoom(), c.zoom() * Math.pow(WHEEL_STEP, -notches)));
      const rect = container.current!.getBoundingClientRect();
      c.zoom({ level, renderedPosition: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
    };
    container.current.addEventListener("wheel", onWheel, { passive: false });

    let viewportWidth = window.innerWidth;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      // 合并连续尺寸变化，避免拖动分隔条时反复 resize + fit
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (c.destroyed()) return;
        c.resize();
        if (viewportWidth !== window.innerWidth) {
          viewportWidth = window.innerWidth;
          if (c.nodes().length) {
            c.fit(undefined, 65);
            if (!domainBoard()) raiseToReadableZoom(c);
          }
        }
      }, 60);
    });
    observer.observe(container.current);
    return () => {
      saveViewport();
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      container.current?.removeEventListener("wheel", onWheel);
      stopMotion();
      clearTimeout(layoutTimer.current);
      layoutSequence.current++;
      c.destroy();
      cy.current = null;
    };
  }, []);

  async function layoutGraph(mode = layoutRef.current, fit = true) {
    const c = cy.current;
    if (!c) return;
    // 域分框的坐标由 domainSummaryElements 直接给出，不能再交给分层算法重排；
    // 否则框和框里的节点会被拆开，正是用户看到的「整理连线后布局错乱」。
    const effective = domainBoard() ? "preset" : mode;
    setLayoutError("");
    if (container.current) container.current.dataset.layoutReady = "";
    try {
      const seq = ++layoutSequence.current;
      layingOut.current = true;
      await applyLayout(c, effective, fit, () => seq === layoutSequence.current);
      // 类型汇总只有几个框，fit 会把它们放大到 1.5 倍以上，字号和边标签反而糊成一团。
      if (!domainBoard() && summaryRef.current && c.zoom() > 1) {
        c.zoom({ level: 1, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } });
      }
      if (container.current && mode === layoutRef.current && seq === layoutSequence.current) {
        container.current.dataset.layoutReady = effective;
        if (restoreViewport.current) {
          restoreCamera(c, restoreViewport.current);
          restoreViewport.current = undefined;
        }
        if (scopeActive.current) {
          c.fit(undefined, 65);
          raiseToReadableZoom(c);
        } else applyFocus();
      }
    } catch (e) {
      setLayoutError(`布局加载失败：${(e as Error).message}`);
    } finally {
      layingOut.current = false;
    }
  }

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    const switched = lastViewportKey.current !== viewportKey;
    if (switched) {
      saveViewport();
      lastViewportKey.current = viewportKey;
    }
    const saved = switched ? boardViewports.get(viewportKey) : undefined;
    // cytoscape 逐条 add 时，边要求两端已存在；先把节点全部放进去，再放边，
    // 并过滤任何指向未知节点的边。按测试域展开曾因「边排在未归组节点之前」整页崩溃。
    const nodeDefinitions = elements.filter((el) => typeof el.data.source !== "string");
    const edgeDefinitions = elements.filter((el) => typeof el.data.source === "string");
    const ids = new Set(nodeDefinitions.map((el) => String(el.data.id)));
    const safeEdges = edgeDefinitions.filter(
      (el) => ids.has(String(el.data.source)) && ids.has(String(el.data.target)),
    );
    const keepIds = new Set([...ids, ...safeEdges.map((el) => String(el.data.id))]);
    // 用内容签名判断「画布内容是否真的变了」：数组引用变而内容没变时不该重新布局
    let changed = lastElements.current !== elementSignature || switched;
    c.batch(() => {
      for (const el of c.elements().toArray())
        if (!keepIds.has(el.id())) {
          el.remove();
          changed = true;
        }
      for (const el of [...nodeDefinitions, ...safeEdges]) {
        const existing = c.getElementById(String(el.data.id));
        if (existing.length) {
          existing.data(el.data);
          // cytoscape 的 data() 是合并而不是替换：退出域分框后，旧的 grouped/group
          // 等汇总标记会留在节点上，把事实/发现继续画成紧凑卡片。这里清掉新数据里
          // 不存在的旧键，恢复原始节点样式和完整标签。
          for (const key of Object.keys(existing.data())) {
            if (!(key in (el.data as any))) existing.removeData(key);
          }
          // 域分框重排后，已有节点也要更新坐标；只更新 data 会让新卡片和旧位置错开。
          if ((el as any).position) existing.position((el as any).position);
        } else {
          c.add(el);
          changed = true;
        }
      }
      // 卡片样式用 class 而不是 data 选择器：退出域分框时先整体清掉，
      // 再只给当前域分框里的输出节点加回，避免残留 data 让事实/发现继续显示为小卡片。
      c.nodes().removeClass("grouped");
      if (summaryRef.current && summaryModeRef.current === "domain") {
        for (const el of nodeDefinitions) {
          if ((el.data as any).grouped) c.getElementById(String(el.data.id)).addClass("grouped");
        }
      } else {
        // 非域分框视图里 group/grouped 没有业务含义；cytoscape 的 data 合并可能留下
        // 上一次域分框的标记，这里直接清掉，保证退出汇总后回到原图节点。
        c.nodes().removeData("group");
        c.nodes().removeData("grouped");
      }
    });
    lastElements.current = elementSignature;
    if (changed) {
      clearTimeout(layoutTimer.current);
      if (container.current) container.current.dataset.layoutReady = "";
      if (saved) {
        appliedFocus.current = saved.focusSeq;
        c.nodes().forEach((n) => {
          if (saved.positions[n.id()]) n.position(saved.positions[n.id()]);
        });
        restoreCamera(c, saved);
        if (
          saved.layout === (domainBoard() ? "preset" : layoutRef.current) &&
          saved.elementSignature === elementSignature &&
          c
            .nodes()
            .toArray()
            .every((n) => !!saved.positions[n.id()])
        ) {
          if (container.current) container.current.dataset.layoutReady = saved.layout;
          if (scopeActive.current) {
            c.fit(undefined, 65);
            raiseToReadableZoom(c);
          } else applyFocus();
          c.resize();
          return;
        }
        restoreViewport.current = saved;
      }
      // 拓扑变化始终使用所选层级算法；状态、选中与视角变化不触发布局。
      // 等用户结束拖动后再排，增量更新保留缩放和平移，不反复缩到全图。
      const arrange = () => {
        if (c.destroyed()) return;
        if (c.nodes(":grabbed").length || performance.now() - interactionAt.current < 500) {
          layoutTimer.current = setTimeout(arrange, 250);
          return;
        }
        void layoutGraph(layoutRef.current, switched && !saved);
      };
      if (switched) void layoutGraph(layoutRef.current, !saved);
      else layoutTimer.current = setTimeout(arrange, 250);
    }
    // 容器位置可能因工具栏/提示条高度变化而移动，重新测量以免命中测试偏移
    c.resize();
  }, [elements, viewportKey]);

  const previousLayout = useRef(layout);
  useEffect(() => {
    if (previousLayout.current === layout) return;
    previousLayout.current = layout;
    void layoutGraph(layout);
  }, [layout]);
  // 链路默认自上而下阅读；离开时恢复整图偏好，不自动改用无序布局。
  const scopedRef = useRef(initialScoped);
  useEffect(() => {
    if (scopedRef.current === scoped) return;
    scopedRef.current = scoped;
    setLayout(scoped ? "dagre_tb" : localPrefs().layout_mode);
  }, [scoped]);
  useEffect(() => {
    if (!scopeActive.current) applyFocus();
  }, [focus]);
  useEffect(() => {
    const update = () => setLayout(localPrefs().layout_mode);
    window.addEventListener("tessera:prefs", update);
    return () => window.removeEventListener("tessera:prefs", update);
  }, []);
  // 选中只做标记：范围过滤已经交给 elements，画布上不留「变暗的全图」
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.elements().removeClass("selected selected-fact");
    for (const id of new Set([...selectedNodes, ...(selected ? [selected] : [])])) {
      c.getElementById(id).addClass("selected");
      c.edges()
        .filter((e) => e.data("step_id") === id)
        .addClass("selected");
    }
    for (const id of selectedFacts) c.getElementById(id).addClass("selected-fact");
  }, [selected, selectedNodes, selectedFacts, elements]);

  function download() {
    const c = cy.current;
    if (!c) return;
    const a = document.createElement("a");
    a.href = c.png({
      bg: getComputedStyle(document.documentElement).getPropertyValue("--map-bg").trim(),
      full: true,
      scale: 2,
    });
    a.download = `${graph.project.id}-${graphId}${summaryOn ? `-${summaryMode}` : ""}.png`;
    a.click();
  }

  const zoomBy = (factor: number) => {
    const c = cy.current;
    if (!c) return;
    // 与滚轮一致：直接落到目标倍率，不做补间（工具条点击要即时、可断言）
    c.zoom(Math.max(c.minZoom(), Math.min(c.maxZoom(), c.zoom() * factor)));
  };

  return (
    <div className="blackboard">
      {scoped && (
        <div className="graph-scope">
          <Route size={12} />
          <strong title={scopeLabel}>{scopeLabel}</strong>
          <em>
            {counts.nodes} 节点 · {counts.edges} 连线
          </em>
          <span className="graph-scope-note">
            {seeds.some((id) => graph.steps.some((s) => s.id === id))
              ? "从起点到任务及其直接产出 · 不展开后续分支"
              : "从起点沿因果向上追溯 · 可继续点选链路内的节点"}
          </span>
          <select
            aria-label="链路深度"
            value={hops}
            onChange={(e) => {
              const next = Number(e.target.value);
              setHops(next);
            }}
          >
            {(
              [
                [SCOPE_FULL, "完整链路"],
                [1, "1 跳"],
                [2, "2 跳"],
                [3, "3 跳"],
              ] as const
            ).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              onClearScope?.();
              callback.current(null);
            }}
          >
            显示全图
          </button>
        </div>
      )}
      <div className="graph-stage">
        <div className="graph-canvas" ref={container} data-scope={scoped ? "chain" : "all"} aria-label="FGS 黑板图" />
        <canvas ref={particles} className="graph-particles" aria-hidden="true" />
        {deciding && (
          <>
            <div className={`graph-decision-scan${motion ? " animated" : ""}`} aria-hidden="true" />
            <span className="graph-decision-state" role="status">
              正在统筹下一步
            </span>
          </>
        )}
        <div className="graph-layout">
          <select
            aria-label="图布局"
            value={layout}
            disabled={summaryOn && summaryMode === "domain"}
            title={summaryOn && summaryMode === "domain" ? "测试域分框使用固定卡片布局，退出分框后可切换" : undefined}
            onChange={(e) => {
              setLayout(e.target.value);
              // 链路视图里的临时选择不写回本地偏好
              if (scopedRef.current) return;
              const prefs = localPrefs();
              localStorage.setItem("tessera.localPrefs", JSON.stringify({ ...prefs, layout_mode: e.target.value }));
            }}
          >
            {layoutOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {summaryOn && (
            <select
              aria-label="汇总方式"
              value={summaryMode}
              onChange={(e) => {
                const mode = e.target.value === "type" ? "type" : "domain";
                setSummaryMode(mode);
                saveSummaryPref(true, mode);
                setExpanded([]);
              }}
            >
              <option value="domain">按测试域分框</option>
              <option value="type">按节点类型</option>
            </select>
          )}
          {layoutError && <span role="alert">{layoutError}</span>}
        </div>
        <div className="graph-toolbar">
          <button aria-label="放大黑板" title="放大" onClick={() => zoomBy(WHEEL_STEP)}>
            <Plus size={15} />
          </button>
          <button aria-label="缩小黑板" title="缩小" onClick={() => zoomBy(1 / WHEEL_STEP)}>
            <Minus size={15} />
          </button>
          <button aria-label="适应黑板" title="适应窗口" onClick={() => cy.current?.fit(undefined, 65)}>
            <Maximize size={15} />
          </button>
          <button aria-label="导出黑板图片" title="导出 PNG" onClick={download}>
            <Download size={15} />
          </button>
          {/* 测试域分框、整理节点与连线放在动效开关正上方 */}
          <button
            aria-label={summaryOn ? "退出汇总" : "按测试域汇总"}
            title={
              scoped
                ? "链路视图下不汇总"
                : summaryOn
                  ? "退出汇总，显示全部节点"
                  : "按测试域分框：每个域一个大框，框内是所属节点"
            }
            aria-pressed={summaryOn}
            disabled={scoped}
            onClick={() => {
              setSummary((value) => {
                saveSummaryPref(!value, summaryModeRef.current);
                return !value;
              });
              setExpanded([]);
            }}
          >
            <Boxes size={15} />
          </button>
          <button
            aria-label="自动整理黑板"
            title={summaryOn && summaryMode === "domain" ? "重新排列测试域卡片" : "按层级整理节点与连线"}
            onClick={() => void layoutGraph()}
          >
            <Network size={15} />
          </button>
          <button
            aria-label={motion ? "关闭黑板动效" : "开启黑板动效"}
            title={motion ? "关闭动效" : "开启动效"}
            aria-pressed={motion}
            onClick={() => {
              const next = !motion;
              setMotion(next);
              writePreference("tessera.graphMotion", next ? "on" : "off");
              if (!next) cy.current?.elements().removeStyle("underlay-opacity line-dash-offset");
            }}
          >
            <Sparkles size={15} />
          </button>
        </div>
        <div className="graph-legend">
          <span className="legend origin">起点</span>
          <span className="legend scope">范围</span>
          <span className="legend fact">事实</span>
          <span className="legend step">任务</span>
          <span className="legend goal">目标</span>
          <span className="legend finding">发现</span>
          {coldNodes(graph).length > 0 && (
            <span className="legend cold" title="超出热节点上限">
              冷 {coldNodes(graph).length}
            </span>
          )}
          {summaryOn && (
            <span className="quiet">
              {summaryMode === "type"
                ? "按类型汇总：点框展开 · 点空白收起"
                : "按测试域分框：框内是所属节点 · 框间数字是跨域关联条数"}
            </span>
          )}
          <span className="quiet">按住 Shift 左键多选</span>
        </div>
        {!graph.steps.length && (
          <div className="graph-empty">
            <GitBranch size={20} />
            <span>从起点到目标 · 等待探索路径</span>
          </div>
        )}
      </div>
    </div>
  );
}
