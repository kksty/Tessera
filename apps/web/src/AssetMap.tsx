import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import {
  Download,
  Maximize,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
} from "lucide-react";
import type { Graph } from "../../../packages/protocol/src/index.js";
import { Badge } from "./components/ui.js";
import { graphMotionEnabled, installGraphMotion } from "./graph-motion.js";
import { api, path } from "./api.js";
import { useWorkspace } from "./workspace.js";
import { boardViewports, useViewState } from "./view-state.js";

const FONT = 'Geist, "Source Sans 3", "Noto Sans SC", "Microsoft YaHei UI", sans-serif';

/** 星图配色：从 CSS token 读取，主题切换时重建（与黑板共用缓存策略）。 */
type Palette = Record<string, Record<string, string>>;
let cachedTheme = "";
let cachedPalette: Palette | null = null;
function readPalette(): Palette {
  const theme = document.documentElement.dataset.theme || "dark";
  if (cachedPalette && cachedTheme === theme) return cachedPalette;
  const css = getComputedStyle(document.documentElement);
  const c = (name: string, fallback = "#8fa3bd") =>
    css.getPropertyValue(name).trim() || fallback;
  const palette: Palette = {
    label: { color: c("--text-2"), "text-background-color": c("--map-bg") },
    project: { "background-color": c("--accent") },
    approved: { "background-color": c("--success"), "border-color": c("--success-ring") },
    pending: { "background-color": c("--warn"), "border-color": c("--warn-ring") },
    rejected: { "background-color": c("--danger"), "border-color": c("--danger-ring") },
    seed: { "background-color": c("--info") },
    running: { "border-color": c("--accent"), "border-width": "2" },
    scope: { "line-color": c("--map-star") },
    discovery: { "line-color": c("--info"), "target-arrow-color": c("--info") },
    selected: { "border-color": c("--accent"), "underlay-color": c("--accent"), "underlay-opacity": "0" },
    selectedEdge: { "line-color": c("--accent") },
  };
  cachedTheme = theme;
  cachedPalette = palette;
  return palette;
}
function applyPalette(c: Core) {
  const p = readPalette();
  c.style()
    .selector("node")
    .style({ ...p.label, "shadow-opacity": 0, "underlay-opacity": 0, "overlay-opacity": 0 } as any)
    .selector('node[type="project"]')
    .style({ ...p.project, "font-weight": "bold" })
    .selector('node[approval="approved"]')
    .style(p.approved)
    .selector('node[approval="pending"]')
    .style(p.pending)
    .selector('node[approval="rejected"]')
    .style(p.rejected)
    .selector('node[type="asset"][seed=1]')
    .style(p.seed)
    .selector('node[type="asset"][seed=1][approval="approved"]')
    .style({ "border-color": p.approved["background-color"] })
    .selector('node[type="asset"][seed=1][approval="pending"]')
    .style({ "border-color": p.pending["background-color"] })
    .selector('node[type="asset"][seed=1][approval="rejected"]')
    .style({ "border-color": p.rejected["background-color"] })
    .selector('node[state="running"]')
    .style(p.running)
    .selector("edge")
    .style(p.scope)
    .selector('edge[relation="discovery"]')
    .style(p.discovery)
    .selector("node:selected")
    .style(p.selected)
    .selector("edge:selected")
    .style(p.selectedEdge)
    .update();
}

export function assetElements(graph: Graph): ElementDefinition[] {
  const root = `project:${graph.project.id}`, nodes: ElementDefinition[] = [{ data: { id: root, label: graph.project.title, type: "project", size: 38 }, position: { x: 0, y: 0 } }];
  const edges: ElementDefinition[] = [], known = new Set(graph.assets.map(a => a.id));
  graph.assets.forEach((a, i) => {
    const angle = i * Math.PI * 2 / Math.max(1, graph.assets.length);
    nodes.push({ data: { id: a.id, label: a.hostname, type: "asset", seed: a.seed ? 1 : 0, approval: a.approval, size: a.seed ? 28 : 17,
      state: graph.steps.some(s => s.asset_id === a.id && s.worker && !s.concluded_at) ? "running" : "idle" },
      position: { x: Math.cos(angle) * (200 + (i % 3) * 60), y: Math.sin(angle) * (200 + (i % 3) * 60) } });
    edges.push({ data: { id: `scope:${a.id}`, source: root, target: a.id, relation: "scope" } });
    const sources = new Map<string, string[]>();
    for (const id of a.evidence_ids) {
      const evidence = graph.evidence.find(e => e.id === id);
      const source = graph.steps.find(s => s.id === evidence?.step_id)?.asset_id || evidence?.asset_id;
      if (source && source !== a.id && known.has(source)) sources.set(source, [...(sources.get(source) || []), id]);
    }
    for (const [source, evidence] of sources) edges.push({ data: {
      id: `discovery:${source}:${a.id}`, source, target: a.id, relation: "discovery", evidence_ids: evidence,
    } });
  });
  return [...nodes, ...edges];
}

export function AssetMap() {
  const ws = useWorkspace(), graph = ws.graph!;
  const host = useRef<HTMLDivElement>(null), motionCanvas = useRef<HTMLCanvasElement>(null), cy = useRef<Core | null>(null);
  const [selected, setSelected] = useViewState<string | null>(`${graph.project.id}:assets:selected`, null);
  const [panelHidden, setPanelHidden] = useState(() => localStorage.getItem("tessera.assetPanelHidden") === "true");
  const asset = graph.assets.find(a => a.id === selected);
  const latest = useRef(graph); latest.current = graph;
  const layout = () => cy.current?.layout({ name: "cose", animate: false, randomize: false, fit: true,
    padding: 80, nodeRepulsion: () => 900000, idealEdgeLength: () => 200, nodeOverlap: 40,
    numIter: 500, gravity: 0.12, initialTemp: 100 }).run();
  useEffect(() => {
    if (!host.current) return;
    const c = cytoscape({ container: host.current, elements: assetElements(latest.current),
      minZoom: 0.15, maxZoom: 4,
      // 交互中保留真实连线与节点，不切换到静态贴图。
      hideEdgesOnViewport: false,
      textureOnViewport: false,
      pixelRatio: "auto",
      // 与黑板一致：滚轮一格约 ×1.10，不再需要滚很多下
      wheelSensitivity: 2,
      style: [
        {
          selector: "core",
          style: { "active-bg-opacity": 0, "active-bg-size": 0 },
        },
        { selector: "node", style: { label: "data(label)", width: "data(size)", height: "data(size)", "font-size": 13,
          "font-family": FONT, "text-valign": "bottom", "text-margin-y": 9,
          "text-background-color": "#080c13", "text-background-opacity": 0, "text-background-padding": "3px",
          "text-background-shape": "roundrectangle",
          "text-wrap": "wrap", "text-max-width": "160px",
          "border-width": 1, "border-color": "#8fa3bd", "border-opacity": 0.5,
          "shadow-blur": 16, "shadow-color": "#6353dc", "shadow-opacity": 0.14,
          "underlay-padding": 7, "underlay-color": "#6353dc" } },
        { selector: 'node[type="project"]', style: { "background-color": "#6353dc", "underlay-opacity": 0.12, "underlay-padding": 18, "shadow-opacity": 0.2,
          "text-valign": "bottom", "font-weight": "bold", "text-margin-y": 14, "font-size": 14 } },
        { selector: 'node[type="asset"]', style: { "underlay-opacity": 0, "shadow-opacity": 0.14 } },
        { selector: 'node[approval="approved"]', style: { "background-color": "#3fbd8c" } },
        { selector: 'node[approval="pending"]', style: { "background-color": "#e2ad4d" } },
        { selector: 'node[approval="rejected"]', style: { "background-color": "#ec6a72", opacity: 0.62 } },
        { selector: 'node[type="asset"][seed=1]', style: { "border-width": 2, "border-opacity": 1 } },
        { selector: 'node[state="running"]', style: { "underlay-opacity": 0.2, "underlay-padding": 12, "shadow-opacity": 0.5 } },
        { selector: "edge", style: { "curve-style": "bezier", width: 1, "line-color": "#7790ad", opacity: 0.22 } },
        { selector: 'edge[relation="discovery"]', style: { "line-color": "#4fc6dd", "target-arrow-color": "#4fc6dd",
          "target-arrow-shape": "triangle", "line-style": "dashed", "line-dash-pattern": [7, 5], width: 1.8, opacity: 0.75 } },
        { selector: "node:selected", style: { "border-width": 2, "border-color": "#6353dc", "border-opacity": 1,
          "underlay-color": "#6353dc", "underlay-opacity": 0.22, "underlay-padding": 14 } },
        { selector: "edge:selected", style: { "line-color": "#6353dc", width: 2.5, opacity: 1 } },
        { selector: ".asset-dimmed", style: { opacity: 0.14 } },
      ], layout: { name: "preset" } } as any);
    cy.current = c;
    applyPalette(c);
    const refreshFonts = () => { if (!c.destroyed()) { c.style().update(); c.resize(); } };
    void document.fonts.ready.then(refreshFonts);
    const themeObserver = new MutationObserver(() => applyPalette(c));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const key = `${latest.current.project.id}:asset-map`, saved = boardViewports.get(key);
    if (saved && c.nodes().toArray().every(n => !!saved.positions[n.id()])) {
      c.nodes().forEach(n => { n.position(saved.positions[n.id()]); }); c.zoom(saved.zoom); c.pan(saved.pan);
    } else layout();
    c.on("tap", "node", e => setSelected(e.target.data("type") === "asset" ? e.target.id() : null));
    c.on("tap", "edge", e => { if (e.target.data("relation") === "discovery") setSelected(e.target.target().id()); });
    c.on("tap", e => { if (e.target === c) setSelected(null); });
    let viewportWidth = window.innerWidth;
    let lastWidth = 0,
      lastHeight = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    // 容器在首次挂载时可能还没有最终尺寸：布局完成后再 fit 一次，避免节点被裁到画布外。
    const fitNow = () => {
      if (c.destroyed()) return;
      c.resize();
      c.fit(undefined, 70);
    };
    const initialFit = requestAnimationFrame(fitNow);
    const resize = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (c.destroyed()) return;
        const rect = host.current?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        c.resize();
        if (
          Math.abs(rect.width - lastWidth) > 2 ||
          Math.abs(rect.height - lastHeight) > 2 ||
          viewportWidth !== window.innerWidth
        ) {
          lastWidth = rect.width;
          lastHeight = rect.height;
          viewportWidth = window.innerWidth;
          c.fit(undefined, 70);
        }
      }, 60);
    });
    resize.observe(host.current);
    const stopMotion = installGraphMotion(c, graphMotionEnabled, motionCanvas.current || undefined);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      cancelAnimationFrame(initialFit);
      boardViewports.set(key, { zoom: c.zoom(), pan: { ...c.pan() }, positions: Object.fromEntries(c.nodes().map(n => [n.id(), { ...n.position() }])), layout: "cose", focusSeq: 0 });
      resize.disconnect(); themeObserver.disconnect(); stopMotion(); c.destroy(); cy.current = null;
    };
  }, [graph.project.id]);
  useEffect(() => {
    const c = cy.current; if (!c) return;
    const elements = assetElements(graph), ids = new Set(elements.map(e => e.data.id));
    let added = false;
    c.batch(() => {
      c.elements().filter(e => !ids.has(e.id())).remove();
      for (const element of elements) {
        const old = c.getElementById(String(element.data.id));
        if (old.length) old.data(element.data); else { c.add(element); added = true; }
      }
    });
    if (added) layout();
  }, [graph]);
  useEffect(() => {
    const c = cy.current; if (!c) return;
    c.elements().unselect().removeClass("asset-dimmed");
    if (selected) { const node = c.getElementById(selected); node.select(); node.connectedEdges('[relation="discovery"]').select(); }
    if (ws.query.trim()) c.nodes('[type="asset"]').filter(n => !n.data("label").includes(ws.query.trim())).addClass("asset-dimmed");
  }, [selected, ws.query, graph]);
  const approved = graph.assets.filter(a => a.approval === "approved").length;
  const pending = graph.assets.filter(a => a.approval === "pending").length;
  return <div className={`asset-map-layout${panelHidden ? " panel-hidden" : ""}`}>
    <div className="asset-star-map">
      <div className="asset-map-title">
        <span className="asset-map-eyebrow">Asset Constellation</span>
        <div className="asset-map-heading">
          <strong>资产星图</strong>
          <span className="asset-map-count">{graph.assets.length} 个资产</span>
        </div>
        <small>圆心为项目本身 · 拖拽节点调整 · 滚轮缩放</small>
      </div>
      <div ref={host} className="asset-map-canvas" aria-label="项目资产星图" />
      <canvas ref={motionCanvas} className="graph-particles" aria-hidden="true" />
      <div className="asset-map-controls">
        <button aria-label={panelHidden ? "展开资产详情" : "收起资产详情"} title={panelHidden ? "展开详情" : "收起详情"} aria-expanded={!panelHidden} onClick={() => { const next = !panelHidden; setPanelHidden(next); localStorage.setItem("tessera.assetPanelHidden", String(next)); }}>{panelHidden ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}</button>
        <button aria-label="放大资产图" title="放大" onClick={() => cy.current?.zoom((cy.current?.zoom() || 1) * 1.2)}><Plus size={15} /></button>
        <button aria-label="缩小资产图" title="缩小" onClick={() => cy.current?.zoom((cy.current?.zoom() || 1) / 1.2)}><Minus size={15} /></button>
        <button aria-label="适应资产图" title="适应窗口" onClick={() => cy.current?.fit(undefined, 80)}><Maximize size={15} /></button>
        <button aria-label="重新排布资产图" title="重新排布" onClick={layout}><RotateCcw size={15} /></button>
        <button aria-label="导出资产图" title="导出 PNG" onClick={() => { const c = cy.current; if (!c) return; const a = document.createElement("a"); a.href = c.png({ bg: document.documentElement.dataset.theme === "light" ? "#f2f5fa" : "#080c13", full: true, scale: 2 }); a.download = `${graph.project.id}-assets.png`; a.click(); }}><Download size={15} /></button>
      </div>
      <div className="asset-map-legend">
        <span className="seed">种子资产 {graph.assets.filter(a => a.seed).length}</span>
        <span className="approved">已批准 {approved}</span>
        <span className="pending">待批准 {pending}</span>
        <span className="rejected">已拒绝 {graph.assets.length - approved - pending}</span>
        <small>淡线：项目收录 · 蓝色虚线：有证据的发现来源（不证明网络连通）</small>
      </div>
    </div>
    <aside className="asset-map-detail" hidden={panelHidden}>
      {asset ? <><small className="mono">{asset.id} · {asset.seed ? "种子资产" : "发现资产"}</small><h2>{asset.hostname}</h2>
        <Badge value={asset.approval === "pending" ? "待批准" : asset.approval} /><p>来源：{asset.source}</p>
        <p>{graph.steps.filter(s => s.asset_id === asset.id).length} 项任务 · {asset.evidence_ids.length} 份来源证据</p>
        {ws.linkEvidence(asset.evidence_ids)}
        {asset.approval === "pending" && <button className="primary" disabled={ws.busy} onClick={() => void ws.action(() => api(path(graph.project.id, "/assets/approve"), { ids: [asset.id] }))}>批准这个资产</button>}
        {asset.approval === "approved" && <button disabled={ws.busy} onClick={() => void ws.action(() => api(path(graph.project.id, "/assets/revoke"), { ids: [asset.id] }))}>撤销批准</button>}
        <small>关系线只表示收录或发现来源，不证明网络连通、信任关系或可利用路径。</small>
      </> : <><h2>全项目资产视图</h2><p>包含种子、待批准与已批准资产。选择一颗星，查看范围状态及发现依据。</p><small>只有批准后才进入测试。图上相近的位置不代表网络连通。</small></>}
    </aside>
  </div>;
}
