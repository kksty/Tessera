import type { Finding } from "../../../../packages/protocol/src/index.js";

/** 分类用文字标签表达：审核页一行里已经有结论、定级和标题，再放图标反而读不出是哪一类。 */
export function FindingKindBadge({ kind, unknownLabel = "待分类" }: { kind: Finding["kind"]; unknownLabel?: string }) {
  return (
    <span className="tag">
      {kind === "informational" ? "信息类" : kind === "vulnerability" ? "漏洞类" : unknownLabel}
    </span>
  );
}
