import { useMemo } from "react";
import { FileText } from "lucide-react";
import type { CoverageEntry, Graph } from "../../../../packages/protocol/src/index.js";
import { coverageCounts, coverageRows, type CoverageStatus } from "../completion-view.js";
import { prettyText } from "../text.js";
import { useWorkspace } from "../workspace.js";

const STATUS_LABEL: Record<CoverageStatus, string> = {
  tested: "已测试",
  waived: "已豁免",
  na: "不适用",
  unrecorded: "未登记",
};

/**
 * Per-surface completion accounting. The table is the human-readable form of
 * `complete.coverage`: every observed host+path is listed, including surfaces
 * the completion did not account for, so an omission is visible rather than
 * hidden behind a count.
 */
export function CoverageTable({ graph, entries }: { graph: Graph; entries: CoverageEntry[] }) {
  const ws = useWorkspace();
  const rows = useMemo(() => coverageRows(graph, entries), [graph, entries]);
  const counts = useMemo(() => coverageCounts(rows), [rows]);
  if (!rows.length) return <p className="quiet">当前图中没有可登记的目标 surface，完成时也未提交覆盖项。</p>;
  return (
    <div className="coverage-panel">
      <div className="coverage-summary" aria-label="覆盖统计">
        <span className="coverage-pill" data-status="tested">
          已测试 {counts.tested}
        </span>
        <span className="coverage-pill" data-status="waived">
          已豁免 {counts.waived}
        </span>
        <span className="coverage-pill" data-status="na">
          不适用 {counts.na}
        </span>
        {counts.unrecorded > 0 && (
          <span className="coverage-pill" data-status="unrecorded">
            未登记 {counts.unrecorded}
          </span>
        )}
        <span className="quiet coverage-summary-total">共 {counts.total} 个 surface</span>
      </div>
      <div className="coverage-scroll">
        <table className="coverage-table">
          <thead>
            <tr>
              <th scope="col">Surface</th>
              <th scope="col">参数</th>
              <th scope="col">处置</th>
              <th scope="col">依据 / 理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-status={row.status}>
                <td data-label="Surface">
                  <span className="coverage-surface mono" title={row.surface}>
                    {row.surface}
                  </span>
                  {!row.observed && <span className="tag coverage-extra">额外声明</span>}
                  {row.fact_ids.length > 0 && (
                    <span className="quiet coverage-facts" title={row.fact_ids.join("、")}>
                      {row.fact_ids.length} 条事实
                    </span>
                  )}
                </td>
                <td className="coverage-parameter mono" data-label="参数">
                  {row.parameter || "—"}
                </td>
                <td data-label="处置">
                  <span className="coverage-status" data-status={row.status}>
                    {STATUS_LABEL[row.status]}
                  </span>
                </td>
                <td className="coverage-basis" data-label="依据 / 理由">
                  {row.reason && <p className="coverage-reason">{prettyText(row.reason)}</p>}
                  {row.evidence_ids.length > 0 ? (
                    <div className="coverage-evidence">
                      <FileText size={12} aria-hidden="true" />
                      {ws.linkEvidence(row.evidence_ids.slice(0, 2))}
                      {row.evidence_ids.length > 2 && <span className="quiet">+{row.evidence_ids.length - 2}</span>}
                    </div>
                  ) : row.status === "unrecorded" ? (
                    <span className="quiet">图中观测到该 surface，完成时未逐项登记。</span>
                  ) : !row.reason ? (
                    <span className="quiet">未记录依据。</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
