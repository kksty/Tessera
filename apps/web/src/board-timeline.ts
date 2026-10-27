import type { Event, Graph } from "../../../packages/protocol/src/index.js";
import { kindLabel } from "./project-activity.js";

/** 时间线只展示人能读懂的中文摘要；内部节点 ID 永远留在详情与提示里。 */
export type BoardTimelineText = { title: string; detail: string };

const LIMIT = 96;

function oneLine(value: unknown, limit = LIMIT): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function records(value: unknown): Record<string, any>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, any> => !!item && typeof item === "object")
    : [];
}

/** 项目目标保存在根 Goal 节点里；Project 头本身没有 goal 字段。 */
function rootGoal(graph?: Graph): string {
  return graph?.goals.find((goal) => goal.id === "goal" && !goal.deleted)?.description || "";
}

function reviewVerdict(value: unknown): string {
  return value === "pass"
    ? "审核通过"
    : value === "rejected"
      ? "审核驳回"
      : value === "needs_evidence"
        ? "需要补充证据"
        : "";
}

function recordText(key: string, record: Record<string, any>, graph?: Graph): string {
  switch (key) {
    case "facts":
      return oneLine(record.conclusion || record.description);
    case "steps":
      return oneLine(record.description);
    case "findings":
      return oneLine(record.title);
    case "hints":
      return oneLine(record.content);
    case "goals":
      return oneLine(record.description);
    case "reviews": {
      const finding = graph?.findings.find((item) => item.id === record.finding_id);
      return [oneLine(finding?.title, 68), reviewVerdict(record.verdict)].filter(Boolean).join(" · ");
    }
    case "assets":
      return oneLine(record.hostname || record.value);
    case "evidence":
      return oneLine(record.title);
    default:
      return oneLine(record.title || record.conclusion || record.description || record.content);
  }
}

/** 按事件类型决定先读哪类变化：例如「修改提示」优先读提示，而不是它顺带改到的任务。 */
function keysFor(kind: string): string[] {
  const prefix = kind.split(".")[0];
  if (prefix === "fact" || prefix === "origin") return ["facts", "goals"];
  if (prefix === "finding") return ["findings", "reviews"];
  if (prefix === "step") return ["steps", "findings"];
  if (prefix === "hint") return ["hints"];
  if (prefix === "goal") return ["goals"];
  if (prefix === "review") return ["reviews", "findings"];
  if (prefix === "decide") return ["steps", "goals", "findings"];
  return ["steps", "facts", "findings", "hints", "goals"];
}

function projectStatusText(status: unknown): string {
  return status === "active"
    ? "启动或恢复项目"
    : status === "stopped"
      ? "暂停项目"
      : status === "completed"
        ? "项目完成"
        : "";
}

/**
 * 把一个黑板事件翻译成时间线文案。
 *
 * 标题是中文动作，副文是这次动作涉及的节点摘要（任务的描述、事实的结论、
 * 发现的标题……），不拼接任何内部 ID。这样同一类事件重复出现时，仍能一眼
 * 看出「这次改的是哪件事」。
 */
export function boardTimelineText(event: Event, graph?: Graph): BoardTimelineText {
  const changes = (event.data.changes || {}) as Record<string, unknown>;
  const project = (changes.project || {}) as Record<string, any>;

  if (event.kind === "project.status") {
    const title = projectStatusText(project.status) || kindLabel(event.kind);
    return { title, detail: oneLine(project.reason) };
  }
  if (event.kind === "project.created" || event.kind === "project.imported") {
    const snapshot = event.data.snapshot as Graph | undefined;
    const detail = [oneLine(snapshot?.project.title || project.title, 48), oneLine(rootGoal(snapshot) || project.goal)]
      .filter(Boolean)
      .join(" · ");
    return { title: kindLabel(event.kind), detail };
  }

  for (const key of keysFor(event.kind)) {
    const list = records(changes[key]);
    if (!list.length) continue;
    const detail = recordText(key, list[0], graph);
    if (detail) return { title: kindLabel(event.kind), detail };
  }

  const snapshot = event.data.snapshot as Graph | undefined;
  if (snapshot?.project) {
    return { title: kindLabel(event.kind), detail: oneLine(rootGoal(snapshot) || snapshot.project.title) };
  }
  return { title: kindLabel(event.kind), detail: "" };
}
