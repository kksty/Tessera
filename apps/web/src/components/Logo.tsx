import { useId } from "react";
import { brand } from "../brand";
import { markClipPath, markPieces, markViewBox } from "../brand-art";

/**
 * 记号：一片瓷砖被 45° 接缝斜切，右上角削出锋利的斜口，右下那片是强调色。
 * 颜色由 CSS 给（基础片继承 currentColor，强调片用 --accent），
 * 单色场景加 data-mono 属性即可退化为纯 currentColor。
 */
export function LogoMark({ className = "", mono = false }: { className?: string; mono?: boolean }) {
  // 同一页面可能同时渲染多个记号；裁切框 id 必须唯一，否则会互相引用。
  const clipId = `tessera-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      className={`logo-mark ${className}`.trim()}
      viewBox={`0 0 ${markViewBox} ${markViewBox}`}
      role="img"
      aria-label={brand.name}
      focusable="false"
      data-mono={mono || undefined}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={markClipPath} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path className="logo-piece" d={markPieces.base} fill="currentColor" />
        <path
          className={mono ? "logo-piece" : "logo-piece-accent"}
          d={markPieces.accent}
          fill={mono ? "currentColor" : undefined}
        />
      </g>
    </svg>
  );
}

/** 字标：全小写，保持几何感；名字本身不带装饰。 */
export function LogoWordmark({ className = "", short = false }: { className?: string; short?: boolean }) {
  return <span className={`logo-wordmark ${className}`.trim()}>{short ? "T" : brand.name.toLowerCase()}</span>;
}

export function LogoLockup({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={`brand-line ${className}`.trim()}>
      <span className="brand-symbol" aria-hidden="true">
        <LogoMark />
      </span>
      {!compact && <LogoWordmark />}
    </span>
  );
}
