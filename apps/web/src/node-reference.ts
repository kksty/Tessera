import type { Graph } from "../../../packages/protocol/src/index.js";

export type NodeReference = { kind: string; text: string };

function short(value: unknown, limit = 56): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** 节点 ID → 中文类型 + 一句可读摘要；引用一律先显示「是什么」，而不是内部编号。 */
export function nodeReference(graph: Graph | undefined, id: string): NodeReference {
  if (!graph) return { kind: "记录", text: "" };
  if (id === "origin") {
    const origin = graph.facts.find((fact) => fact.id === "origin");
    return { kind: "起点", text: short(origin?.conclusion || origin?.description) };
  }
  const step = graph.steps.find((item) => item.id === id);
  if (step) return { kind: "任务", text: short(step.description) };
  const fact = graph.facts.find((item) => item.id === id);
  if (fact) return { kind: "事实", text: short(fact.conclusion || fact.description) };
  const finding = graph.findings.find((item) => item.id === id);
  if (finding) return { kind: "发现", text: short(finding.title) };
  const hint = graph.hints.find((item) => item.id === id);
  if (hint) return { kind: "提示", text: short(hint.content) };
  const goal = graph.goals.find((item) => item.id === id);
  if (goal) return { kind: "目标", text: short(goal.description) };
  const evidence = graph.evidence.find((item) => item.id === id);
  if (evidence) return { kind: "证据", text: short(evidence.title) };
  const asset = graph.assets.find((item) => item.id === id);
  if (asset) return { kind: "资产", text: short(asset.hostname) };
  return { kind: "记录", text: "" };
}
