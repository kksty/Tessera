import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { severityLabels, severityOrder } from "../format.js";
const riskOrder = severityOrder.filter((key) => key !== "informational" && key !== "ungraded");
import type {
  OverviewTrendPoint,
  OverviewUsage,
  OverviewUsagePoint,
  SeverityCounts,
} from "../../../../packages/protocol/src/index.js";

const sum = (counts: SeverityCounts) => riskOrder.reduce((total, key) => total + (counts[key] || 0), 0);

/**
 * 横向风险分布条：一块一条，颜色与顺序跟图例一致。
 * 直角、2px 墨色缝、发丝外框——不用圆角胶囊，也不做渐变。
 */
export function SeverityBar({ counts, height = 8 }: { counts: SeverityCounts; height?: number }) {
  const total = sum(counts);
  if (!total)
    return (
      <div className="severity-bar empty" style={{ height }} aria-label="暂无已确认漏洞">
        <span />
      </div>
    );
  return (
    <div
      className="severity-bar"
      style={{ height }}
      role="img"
      aria-label={riskOrder.map((key) => `${severityLabels[key]} ${counts[key]}`).join("，")}
    >
      {riskOrder.map((key) => {
        const value = counts[key] || 0;
        if (!value) return null;
        return (
          <span
            key={key}
            data-severity={key}
            style={{ width: `${(value / total) * 100}%` }}
            title={`${severityLabels[key]} ${value}`}
          />
        );
      })}
    </div>
  );
}

/**
 * 风险分布：一行一个等级，横条长度按当前最大值归一，数值直接写在行尾。
 * 顺序固定严重→低危，读的时候不用先看图例。
 */
export function SeverityRows({ counts }: { counts: SeverityCounts }) {
  const max = Math.max(1, ...riskOrder.map((key) => counts[key] || 0));
  return (
    <ul className="risk-rows" aria-label="已确认漏洞的风险分布">
      {riskOrder.map((key) => {
        const value = counts[key] || 0;
        return (
          <li key={key} data-severity={key} data-zero={value ? undefined : "true"}>
            <span className="risk-row-label">{severityLabels[key]}</span>
            <span className="risk-row-track">{value > 0 && <i style={{ width: `${(value / max) * 100}%` }} />}</span>
            <span className="risk-row-value">{value}</span>
          </li>
        );
      })}
    </ul>
  );
}

const TREND_HEIGHT = 132;
const TREND_TOP = 14;
const TREND_BOTTOM = 26;
const TREND_LEFT = 30;
const TREND_RIGHT = 10;

/**
 * 近 14 天新增漏洞。柱状图带一条零基线和三档刻度：
 * 量级再小也能看出每天的相对高低，而不是一排悬空的小方块。
 */
export function TrendChart({ points }: { points: OverviewTrendPoint[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const total = points.reduce((sum, point) => sum + point.created, 0);
  const peak = Math.max(0, ...points.map((point) => point.created));
  const peakIndex = points.findIndex((point) => point.created === peak);
  const baseline = TREND_HEIGHT - TREND_BOTTOM;
  const plotHeight = baseline - TREND_TOP;
  const plotWidth = Math.max(1, width - TREND_LEFT - TREND_RIGHT);
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(3, Math.min(30, slot * 0.5));
  // 顶部刻度取偶数，保证中间刻度是整数，柱顶也不会贴着画布上沿。
  const max = Math.max(2, peak + (peak % 2));
  const x = (index: number) => TREND_LEFT + slot * (index + 0.5);
  const y = (value: number) => baseline - (Math.min(value, max) / max) * plotHeight;
  const ticks = [max, max / 2, 0];
  const last = points.length - 1;
  // 宽度够就逐日标，不够再退到隔天 / 隔两天；末位始终保留。
  const step = slot >= 34 ? 1 : slot >= 17 ? 2 : 3;
  const labelled = (index: number) => step === 1 || index === last || (index % step === 0 && index !== last - 1);
  const aria =
    `最近 ${points.length} 天新增漏洞共 ${total} 项，峰值 ${peak} 项每天` +
    (peak > 0 ? `（${points[peakIndex]?.day.slice(5)}）` : "") +
    `。每日：` +
    points.map((point) => `${point.day} ${point.created}`).join("；");

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="trend-strip">
      <div className="trend-strip-head">
        <span className="trend-strip-total">
          <b>{total}</b>
          <span>项新增</span>
        </span>
        <span className="trend-strip-peak">峰值 {peak} 项 / 天</span>
      </div>
      <div className="trend-plot" ref={host} style={{ height: TREND_HEIGHT }}>
        {width > 0 && (
          <svg width={width} height={TREND_HEIGHT} role="img" aria-label={aria} onMouseLeave={() => setActive(null)}>
            <g className="trend-grid">
              {ticks
                .filter((tick) => tick > 0)
                .map((tick) => (
                  <line key={`grid-${tick}`} x1={TREND_LEFT} x2={width - TREND_RIGHT} y1={y(tick)} y2={y(tick)} />
                ))}
            </g>
            <line className="trend-axis" x1={TREND_LEFT} x2={width - TREND_RIGHT} y1={baseline} y2={baseline} />
            {ticks.map((tick) => (
              <text
                className="trend-tick"
                key={`tick-${tick}`}
                x={TREND_LEFT - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {tick}
              </text>
            ))}
            {points.map((point, index) =>
              point.created > 0 ? (
                <rect
                  className="trend-bar"
                  key={`bar-${point.day}`}
                  data-active={active === index || undefined}
                  x={x(index) - barWidth / 2}
                  y={y(point.created)}
                  width={barWidth}
                  height={baseline - y(point.created)}
                  rx={1.5}
                >
                  <title>{`${point.day}：新增漏洞 ${point.created} 项，审核 ${point.reviewed} 次`}</title>
                </rect>
              ) : null,
            )}
            {points.map((point, index) =>
              labelled(index) ? (
                <text
                  className="trend-day"
                  key={`day-${point.day}`}
                  x={x(index)}
                  y={TREND_HEIGHT - 8}
                  textAnchor="middle"
                >
                  {point.day.slice(5)}
                </text>
              ) : null,
            )}
            {active !== null && (
              <text className="trend-value" x={x(active)} y={y(points[active].created) - 5} textAnchor="middle">
                {points[active].created}
              </text>
            )}
            {points.map((point, index) => (
              <rect
                className="trend-hit"
                key={`hit-${point.day}`}
                x={TREND_LEFT + slot * index}
                y={TREND_TOP}
                width={slot}
                height={baseline - TREND_TOP}
                onMouseEnter={() => setActive(index)}
              />
            ))}
          </svg>
        )}
      </div>
      <p className="chart-note">按发现创建时间统计，不含审核动作。</p>
    </div>
  );
}

const TOKEN_CHART_HEIGHT = 176;
const TOKEN_NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const tokenPointTotal = (point: OverviewUsagePoint) => point.input + point.output;

/** 刻度用紧凑单位；中文标签留给说明文字，坐标轴只放数字。 */
const tokenTick = (value: number) => {
  const trim = (number: number, digits: number) => number.toFixed(digits).replace(/\.0+$/, "");
  if (value >= 1_000_000) return `${trim(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${trim(value / 1_000, value >= 100_000 ? 0 : 1)}k`;
  return value.toLocaleString("zh-CN");
};

const tokenFull = (value: number) => value.toLocaleString("zh-CN");

/** 顶部刻度取 1 / 1.25 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 的整数档。 */
const niceCeiling = (value: number) => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const fraction = value / power;
  return (TOKEN_NICE_STEPS.find((step) => fraction <= step) ?? 10) * power;
};

/**
 * 跨项目 Token 消耗：近 14 天折线。
 * 单一主序列 + 淡填充；网格是发丝线，峰值单独标注，悬停才显示分日明细。
 */
export function TokenTrendChart({ usage }: { usage: OverviewUsage }) {
  const points = usage.trend;
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tipWidth, setTipWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 先量出提示框的实际宽度，再把它夹在绘图区内，避免遮住左侧刻度。
  useLayoutEffect(() => {
    if (active !== null && tip.current) setTipWidth(tip.current.offsetWidth);
  }, [active]);

  if (!points.length) return null;

  const totals = points.map(tokenPointTotal);
  const peak = Math.max(0, ...totals);
  const peakIndex = totals.indexOf(peak);
  // 峰值上方留一点余量；最小值抬到 4，避免零数据时出现 0.5 这类刻度。
  const max = niceCeiling(Math.max(4, peak * 1.06));
  const total = usage.input + usage.output;
  const left = width < 440 ? 42 : 50;
  const right = 12;
  const top = 16;
  const bottom = 24;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = TOKEN_CHART_HEIGHT - top - bottom;
  const baseline = top + plotHeight;
  const slotWidth = plotWidth / Math.max(1, points.length - 1);
  const x = (index: number) => left + index * slotWidth;
  const y = (value: number) => baseline - (Math.min(value, max) / max) * plotHeight;
  const ticks = peak > 0 ? [max, max / 2, 0] : [0];
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(tokenPointTotal(point)).toFixed(2)}`)
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(2)},${baseline} L${x(0).toFixed(2)},${baseline} Z`;
  const showDayLabel = (index: number) => {
    const last = points.length - 1;
    if (slotWidth >= 56) return index % 2 === 0 || index === last;
    const every = slotWidth >= 38 ? 2 : 3;
    return index === last || (last - index) % every === 0;
  };
  const activePoint = active === null ? null : points[active];
  const activeY = activePoint ? y(tokenPointTotal(activePoint)) : 0;
  const tipLeft = active === null ? 0 : Math.max(left - 2, Math.min(x(active) - tipWidth / 2, width - tipWidth - 4));
  const aria =
    `近 ${points.length} 天共 ${tokenFull(total)} Token；输入 ${tokenFull(usage.input)}，` +
    `输出 ${tokenFull(usage.output)}。每日：` +
    points.map((point) => `${point.day} ${tokenFull(tokenPointTotal(point))}`).join("；");

  return (
    <div className="token-chart">
      <div className="token-chart-head">
        <span className="token-chart-total">
          <b>{tokenTick(total)}</b>
          <span>Token · 近 {points.length} 天</span>
        </span>
        <dl className="token-chart-stats">
          <div>
            <dt>输入</dt>
            <dd>{tokenTick(usage.input)}</dd>
          </div>
          <div>
            <dt>输出</dt>
            <dd>{tokenTick(usage.output)}</dd>
          </div>
          <div>
            <dt>缓存读 / 写</dt>
            <dd>
              {tokenTick(usage.cache_read)} / {tokenTick(usage.cache_write)}
            </dd>
          </div>
          <div>
            <dt>峰值</dt>
            <dd>{tokenTick(peak)} / 天</dd>
          </div>
        </dl>
      </div>

      <div className="token-chart-plot" ref={host}>
        {width > 0 && (
          <svg
            width={width}
            height={TOKEN_CHART_HEIGHT}
            role="img"
            aria-label={aria}
            onMouseLeave={() => setActive(null)}
          >
            <g className="token-grid">
              {ticks
                .filter((tick) => tick > 0)
                .map((tick) => (
                  <line key={`grid-${tick}`} x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
                ))}
            </g>
            <line className="token-axis" x1={left} x2={width - right} y1={baseline} y2={baseline} />
            {ticks.map((tick) => (
              <text
                className="token-tick"
                key={`tick-${tick}`}
                x={left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {tokenTick(tick)}
              </text>
            ))}
            <path className="token-area" d={area} />
            <path className="token-line" d={line} />
            {points.map((point, index) =>
              showDayLabel(index) ? (
                <text
                  className="token-day"
                  key={`day-${point.day}`}
                  x={x(index)}
                  y={TOKEN_CHART_HEIGHT - 6}
                  textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                >
                  {point.day.slice(5)}
                </text>
              ) : null,
            )}
            {peak > 0 && active !== peakIndex && (
              <text
                className="token-peak"
                x={x(peakIndex)}
                y={y(peak) < top + 14 ? y(peak) + 15 : y(peak) - 8}
                textAnchor={peakIndex === 0 ? "start" : peakIndex === points.length - 1 ? "end" : "middle"}
              >
                {tokenTick(peak)}
              </text>
            )}
            {active !== null && activePoint && (
              <>
                <line className="token-hover-line" x1={x(active)} x2={x(active)} y1={top} y2={baseline} />
                <circle className="token-hover-dot" cx={x(active)} cy={activeY} r={3.5} />
              </>
            )}
            {points.map((point, index) => (
              <rect
                key={`hit-${point.day}`}
                className="token-hit"
                data-day={point.day}
                x={x(index) - slotWidth / 2}
                y={top}
                width={slotWidth}
                height={plotHeight}
                onMouseEnter={() => setActive(index)}
              />
            ))}
          </svg>
        )}
        {active !== null && activePoint && (
          <div
            ref={tip}
            className="token-tip"
            data-below={activeY < 84 ? "true" : undefined}
            style={{ left: tipLeft, top: activeY }}
          >
            <span className="token-tip-head">
              <span className="token-tip-day">{activePoint.day.slice(5)}</span>
              <strong>
                {tokenFull(tokenPointTotal(activePoint))}
                <small>Token</small>
              </strong>
            </span>
            <span>
              输入 {tokenFull(activePoint.input)} · 输出 {tokenFull(activePoint.output)} · {activePoint.requests} 次请求
              {activePoint.unknown ? ` · ${activePoint.unknown} 未知` : ""}
            </span>
          </div>
        )}
      </div>

      <p className="chart-note">
        按 UTC 日期汇总全部项目最近 {points.length} 天的模型请求；输入含缓存读写。
        {usage.unknown
          ? `${usage.unknown} 次请求的用量未完整上报，缺失部分未计入 Token 合计。`
          : "用量只统计已记录的请求，不代表剩余额度。"}
      </p>
      <ul className="sr-only" aria-label={`近 ${points.length} 天每日 Token 用量`}>
        {points.map((point) => (
          <li key={`sr-${point.day}`}>
            {point.day}：输入 {tokenFull(point.input)}，输出 {tokenFull(point.output)}，{point.requests} 次请求
            {point.unknown ? `，其中 ${point.unknown} 次用量不完整` : ""}。
          </li>
        ))}
      </ul>
    </div>
  );
}
