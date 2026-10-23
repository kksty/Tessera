import { useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import type { Graph } from "../../../../packages/protocol/src/index.js";
import { summarizeUsage } from "../../../../packages/protocol/src/usage.js";
import { compactNumber } from "../format.js";

export function ProjectUsage({ graph, compact = false }: { graph: Graph; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const totals = summarizeUsage(graph.usage);
  const show = (counter: { known: number; unknown: number }) =>
    counter.unknown
      ? `${compactNumber(counter.known)} +${counter.unknown} 未知`
      : compactNumber(counter.known);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="usage-menu" ref={ref}>
      <button
        type="button"
        className={compact ? "icon-button topbar-tool" : "button ghost small"}
        aria-label="查看项目用量"
        title="查看项目用量"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Gauge size={15} />
        {!compact && "用量"}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="模型用量">
          <header>
            <span className="eyebrow">MODEL USAGE</span>
            <strong>项目累计用量</strong>
          </header>
          <div className="usage-pop-grid">
            <div>
              <small>输入总 Token</small>
              <strong>{show(totals.input)}</strong>
            </div>
            <div>
              <small>输出 Token</small>
              <strong>{show(totals.output)}</strong>
            </div>
            <div>
              <small>缓存读 / 写</small>
              <strong>
                {compactNumber(totals.cache_read.known)} / {compactNumber(totals.cache_write.known)}
              </strong>
            </div>
            <div>
              <small>费用</small>
              <strong>{show(totals.cost)}</strong>
            </div>
          </div>
          <table className="usage-pop-table">
            <thead>
              <tr>
                <th>活动</th>
                <th className="num">次数</th>
                <th className="num">Token</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["decide", "决策"],
                  ["execute", "执行"],
                  ["review", "审核"],
                ] as const
              ).map(([kind, label]) => {
                const records = graph.usage.filter((usage) => usage.kind === kind);
                const summary = summarizeUsage(records);
                return (
                  <tr key={kind}>
                    <td>{label}</td>
                    <td className="num">{records.length}</td>
                    <td className="num">
                      {show({
                        known: summary.input.known + summary.output.known,
                        unknown: records.filter((record) => record.input == null || record.output == null)
                          .length,
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="usage-pop-note">
            输入总量已包含缓存，分桶不重复相加。用量来自已记录的请求，不代表剩余额度。
          </p>
        </div>
      )}
    </div>
  );
}
