import type { Core } from "cytoscape";
import { readPreference } from "./preferences.js";

/** 动效默认开启，只由黑板工具栏的开关决定。
 *  不能再用 prefers-reduced-motion 静默关掉：Windows 关闭「动画效果」、远程桌面和部分
 *  虚拟机都会让这个媒体查询命中，用户点「开启动效」后画布却仍是暂停的，看起来就是动效失效。 */
export function graphMotionEnabled() {
  return readPreference("tessera.graphMotion") !== "off";
}

/** 只强调正在执行的节点与路径。细线呼吸和顺向流标不改变节点位置，
 *  不绘制光晕；拖拽、缩放或页面隐藏时暂停。单帧最多 32 节点 / 24 连线。 */
export function installGraphMotion(c: Core, enabled: () => boolean, canvas?: HTMLCanvasElement) {
  if (!canvas) return () => {};
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  let frame = 0, pausedUntil = 0, previous = 0;
  let grabbing = false, paletteDirty = true, activityDirty = true;
  let color = "#667ac4";
  let nodes = c.nodes('[state="running"]').slice(0, 32);
  let edges = c.edges('[status="running"]').slice(0, 24);
  const clear = () => {
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height); context.restore();
  };
  const pause = () => {
    pausedUntil = performance.now() + 180;
    clear(); canvas.dataset.motionState = "paused";
  };
  const grab = () => { grabbing = true; pause(); };
  const free = () => { grabbing = false; pause(); };
  const refresh = () => { activityDirty = true; };
  const theme = new MutationObserver(() => { paletteDirty = true; });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  c.on("pan zoom resize position layoutstart layoutstop", pause);
  c.on("grab", grab); c.on("free", free);
  c.on("add remove data", refresh);

  const draw = (time: number) => {
    frame = requestAnimationFrame(draw);
    if (time - previous < 40) return;
    previous = time;
    if (activityDirty) {
      nodes = c.nodes('[state="running"]').slice(0, 32);
      edges = c.edges('[status="running"]').slice(0, 24);
      canvas.dataset.activeNodes = String(nodes.length);
      canvas.dataset.activeEdges = String(edges.length);
      activityDirty = false;
    }
    if (document.hidden || !enabled() || grabbing || time < pausedUntil) {
      if (canvas.dataset.motionState !== "paused") { clear(); canvas.dataset.motionState = "paused"; }
      return;
    }
    if (!nodes.length && !edges.length) {
      if (canvas.dataset.motionState !== "idle") { clear(); canvas.dataset.motionState = "idle"; }
      return;
    }
    const ratio = Math.min(2, window.devicePixelRatio || 1), width = c.width(), height = c.height();
    // canvas 是替换元素：只写 inset: 0 时 auto 宽高会取位图自身的尺寸，而不会撑满容器。
    // DPR > 1 时位图比容器大，浏览器就按「位图 px = CSS px」布局，光晕于是以容器左上角为原点
    // 被放大，界面对缩放后和节点对不上。CSS 盒尺寸必须显式钉在容器（也就是 renderedBoundingBox
    // 的坐标系）尺寸上，位图尺寸只负责清晰度。
    const cssWidth = `${width}px`, cssHeight = `${height}px`;
    if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
    const bitmapWidth = Math.round(width * ratio), bitmapHeight = Math.round(height * ratio);
    if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
    if (paletteDirty) {
      const css = getComputedStyle(document.documentElement);
      color = css.getPropertyValue("--motion-accent").trim() || css.getPropertyValue("--accent").trim();
      canvas.dataset.motionColor = color; paletteDirty = false;
    }
    clear(); context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1.25;
    for (const node of nodes) {
      if (node.removed()) continue;
      const box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false, includeUnderlays: false });
      if (box.x2 < 0 || box.y2 < 0 || box.x1 > width || box.y1 > height) continue;
      const breath = (1 - Math.cos(time * Math.PI * 2 / 2800)) / 2;
      const gap = 2.5 + breath * 3;
      context.globalAlpha = 0.25 + (1 - breath) * 0.3;
      context.beginPath();
      if (node.style("shape") === "ellipse")
        context.ellipse((box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, box.w / 2 + gap, box.h / 2 + gap, 0, 0, Math.PI * 2);
      else context.roundRect(box.x1 - gap, box.y1 - gap, box.w + gap * 2, box.h + gap * 2, 8);
      context.stroke();
    }
    const zoom = c.zoom(), pan = c.pan();
    context.globalAlpha = 0.85; context.lineCap = "round";
    edges.forEach((edge, index) => {
      if (edge.removed()) return;
      const start = edge.sourceEndpoint(), end = edge.targetEndpoint(), control = edge.controlPoints()?.[0];
      const point = (t: number) => {
        const u = 1 - t;
        return { x: (control ? u*u*start.x + 2*u*t*control.x + t*t*end.x : u*start.x + t*end.x) * zoom + pan.x,
          y: (control ? u*u*start.y + 2*u*t*control.y + t*t*end.y : u*start.y + t*end.y) * zoom + pan.y };
      };
      const t = (time / 3400 + index * 0.19) % 1, head = point(t), tail = point(Math.max(0, t - 0.035));
      if (!Number.isFinite(head.x) || !Number.isFinite(head.y) || head.x < 0 || head.x > width || head.y < 0 || head.y > height) return;
      context.beginPath(); context.moveTo(tail.x, tail.y); context.lineTo(head.x, head.y); context.stroke();
      context.beginPath(); context.arc(head.x, head.y, 1.6, 0, Math.PI * 2); context.fill();
    });
    context.globalAlpha = 1;
    canvas.dataset.motionState = "running";
  };
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame); theme.disconnect();
    c.off("pan zoom resize position layoutstart layoutstop", pause);
    c.off("grab", grab); c.off("free", free); c.off("add remove data", refresh); clear();
  };
}
