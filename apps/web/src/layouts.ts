import type { Core } from "cytoscape";
export const layoutOptions = [
  ["dagre_tb", "Dagre ↓"],
  ["dagre_lr", "Dagre →"],
  ["klay_tb", "Klay ↓"],
  ["klay_lr", "Klay →"],
  ["elk_tb", "ELK ↓"],
  ["elk_lr", "ELK →"],
] as const;
export function localPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("tessera.localPrefs") || "{}");
    return {
      actor_name: typeof p.actor_name === "string" && p.actor_name.trim() ? p.actor_name : "Human",
      layout_mode: layoutOptions.some(([v]) => v === p.layout_mode) ? p.layout_mode : "dagre_tb",
    };
  } catch {
    return { actor_name: "Human", layout_mode: "dagre_tb" };
  }
}
export async function applyLayout(c: Core, mode: string, fit = true, current = () => true) {
  const direction = mode.endsWith("_lr") ? "LR" : "TB";
  // 所有选项均保留因果方向；不因图宽而改用力导向。
  let options: any;
  if (mode === "preset") {
    // 域分框的节点位置已由 domainSummaryElements 按卡片算好；这里只负责适应窗口。
    options = { name: "preset", fit, padding: 28, animate: false };
  } else if (mode.startsWith("klay")) {
    const [{ default: cytoscape }, plugin] = await Promise.all([import("cytoscape"), import("cytoscape-klay")]);
    cytoscape.use(plugin.default);
    options = {
      name: "klay",
      fit,
      padding: 28,
      animate: false,
      klay: {
        direction: direction === "LR" ? "RIGHT" : "DOWN",
        spacing: 48,
        nodeLayering: "NETWORK_SIMPLEX",
      },
    };
  } else if (mode.startsWith("elk")) {
    const [{ default: cytoscape }, plugin] = await Promise.all([import("cytoscape"), import("cytoscape-elk")]);
    cytoscape.use(plugin.default);
    options = {
      name: "elk",
      fit,
      padding: 28,
      animate: false,
      elk: {
        algorithm: "layered",
        "elk.direction": direction === "LR" ? "RIGHT" : "DOWN",
        "elk.spacing.nodeNode": "44",
        "elk.layered.spacing.nodeNodeBetweenLayers": "68",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      },
    };
  } else
    options = {
      name: "dagre",
      rankDir: direction,
      nodeSep: 30,
      rankSep: 68,
      edgeSep: 12,
      ranker: "network-simplex",
      fit,
      padding: 28,
      animate: false,
    };
  if (c.destroyed() || !current()) return;
  const layout = c.layout(options);
  await new Promise<void>((resolve) => {
    layout.one("layoutstop", () => resolve());
    layout.run();
  });
  // 域分框先保证整张图可见；强行抬到可读字号会把框和标题裁掉。
  if (fit && mode !== "preset") raiseToReadableZoom(c);
}

/**
 * 适配窗口后再把缩放抬到「节点文字读得出来」的档位。
 * 这不是装饰：`min-zoomed-font-size` 让文字在过小的缩放下整块消失，
 * 首屏就只剩一排空盒子。宁可让整张图超出画布（可以拖拽/缩小看全），
 * 也不要在进入页面时看不到任何一条结论。
 */
export const MIN_READABLE_ZOOM = 0.62;

export function raiseToReadableZoom(c: Core) {
  if (c.destroyed() || !c.nodes().length) return;
  const zoom = c.zoom();
  if (zoom >= MIN_READABLE_ZOOM) return;
  c.zoom({
    level: MIN_READABLE_ZOOM,
    renderedPosition: { x: c.width() / 2, y: c.height() / 2 },
  });
}
