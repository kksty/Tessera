/** 统一的展示格式化与状态文案，避免各页面各写一套。 */

export const fmt = (value: string | number | null | undefined) =>
  value === null || value === undefined ? "—" : new Date(value).toLocaleString("zh-CN", { hour12: false });

export const fmtDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—";

export const fmtDay = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "—";

export const fmtTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";

export const fmtNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");

/** 相对时间：一周内用「x 分钟前」，更早回落到日期。 */
export function fromNow(value: string | null | undefined, now = Date.now()) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return fmtDay(value);
}

export function fmtBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

export const pct = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

export const statusLabels: Record<string, string> = {
  active: "运行中",
  stopped: "已暂停",
  completed: "已完成",
  pending: "待审核",
  passing: "已审核",
  pass: "审核通过",
  candidate: "候选",
  confirmed: "已确认",
  rejected: "已驳回",
  needs_evidence: "缺证据",
  approved: "已批准",
  cooled: "冷处理",
  observation: "观测",
  observed: "已观测",
  disputed: "有争议",
  satisfied: "已满足",
  withdrawn: "已撤销",
  open: "待领取",
  running: "执行中",
  done: "已完成",
  executed: "待关闭",
  discarded: "已废弃",
  failed: "失败待处理",
  draining: "等待收敛",
  navigation: "交接索引",
  needs_attention: "需人工检查",
  succeeded: "成功",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const severityLabels: Record<string, string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  informational: "信息",
  ungraded: "未定级",
};

export const severityOrder = ["critical", "high", "medium", "low", "informational", "ungraded"] as const;

export type SeverityKey = (typeof severityOrder)[number];

/** 项目状态 → 语义色。 */
export const statusTone = (status: string): "accent" | "success" | "warn" | "danger" | "neutral" => {
  switch (status) {
    case "active":
      return "accent";
    case "completed":
      return "success";
    case "stopped":
      return "warn";
    case "rejected":
    case "failed":
    case "needs_attention":
      return "danger";
    default:
      return "neutral";
  }
};

export const reviewTone = (status: string): "accent" | "success" | "warn" | "danger" | "neutral" => {
  switch (status) {
    case "pass":
      return "success";
    case "pending":
      return "warn";
    case "needs_evidence":
      return "warn";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
};

export const verdictLabel: Record<string, string> = {
  pass: "审核通过",
  needs_evidence: "需要补充证据",
  rejected: "驳回",
};

/** 数字紧凑显示：1.2k / 12.4k。 */
export const compactNumber = (value: number) =>
  value >= 10000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString("zh-CN");
