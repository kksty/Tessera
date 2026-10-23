import type { Event, Finding, Graph } from "../../../packages/protocol/src/index.js";
import { changedIds } from "./replay.js";
import { activeGraph } from "../../../packages/protocol/src/node-lifecycle.js";
import { workEventFilter } from "../../../packages/protocol/src/work-events.js";

export const severityLevels = [["critical", "严重"], ["high", "高危"], ["medium", "中危"], ["low", "低危"]] as const;
export { confirmedFinding, informationalFinding, confirmedVulnerability, confirmedInformational } from "../../../packages/protocol/src/finding-policy.js";
export function projectRuntime(events: Event[], createdAt: string, now = Date.now()) {
  let since = Date.parse(createdAt), status = "active", duration = 0;
  for (const event of events) {
    const next = (event.data.snapshot as Graph | undefined)?.project.status || (event.data.changes as any)?.project?.status;
    if (!next || next === status) continue;
    const time = Math.max(since, Date.parse(event.created_at));
    if (status === "active") duration += time - since;
    status = next; since = time;
  }
  return Math.max(0, duration + (status === "active" ? now - since : 0));
}
export const activityLabels: Record<string, string> = {
  "project.created": "创建项目", "project.imported": "导入项目", "project.status": "项目状态变化", "project.updated": "更新项目",
  "decide.committed": "调整探索方向", "decide.conflicted": "刷新决策", "step.declared": "新增探索任务",
  "step.executed": "执行结束", "step.completed": "执行结束", "step.updated": "调整任务", "fact.observed": "新增观测",
  "finding.submitted": "提交或修订发现", "finding.reviewed": "审核发现", "finding.reviewed.manually": "人工审核发现",
  "finding.deleted": "人工删除漏洞", "finding.returned": "人工打回漏洞", "finding.retest_requested": "人工要求重测",
  "hint.added": "补充提示", "hint.updated": "修改提示", "hint.withdrawn": "撤回提示",
  "assets.discovered": "发现资产", "assets.approved": "批准测试资产", "assets.revoked": "撤销资产批准",
  "job.failed": "运行失败", "evidence.saved": "归档证据", "usage.recorded": "记录用量",
  "step.claimed": "领取任务", "step.released": "释放任务", "jobs.state": "运行状态变化",
  "project.renamed": "重命名项目", "project.completed.manually": "人工完成项目", "run.retry_confirmed": "确认重新执行",
  "goal.edited": "改写项目目标", "origin.edited": "改写项目起点",
  "report.created": "生成报告快照", "report.stale": "报告快照已过期",
  "bookmark.updated": "更新回访书签",
};
export type ActivityRow = { key: number; index: number; time: string; title: string; detail: string; actor: string; category: string; targets: string[]; kind: string; reason: string };

/** Fold a task's incremental observations into its completion, preserving exact replay indices. */
export function projectActivity(events: Event[], graph: Graph, all = false): ActivityRow[] {
  events = events.map(workEventFilter(graph));
  graph = activeGraph(graph);
  const known = new Set([...graph.steps, ...graph.facts, ...graph.findings, ...graph.goals, ...graph.hints, ...graph.assets, ...graph.evidence].map(r => r.id));
  const completed = new Set<string>();
  for (const e of events) if (e.kind === "step.executed" || e.kind === "step.completed") for (const s of (e.data.changes as any)?.steps || []) if (s.executed_at || s.concluded_at) completed.add(s.id);
  const prior = new Map<string, any>();
  const rows: ActivityRow[] = [];
  let previousStatus: string | undefined;
  events.forEach((e, index) => {
    const c = (e.data.changes || {}) as Record<string, any>;
    const records: any[] = Object.values(c).flatMap(v => Array.isArray(v) ? v : []);
    const old = new Map(records.filter(r => r.id && prior.has(r.id)).map(r => [r.id, prior.get(r.id)]));
    const snapshot = e.data.snapshot as Graph | undefined;
    const status = c.project?.status || snapshot?.project.status;
    const becameCompleted = previousStatus && status === "completed" && previousStatus !== status;
    if (status) previousStatus = status;
    if (snapshot) for (const v of [...snapshot.steps, ...snapshot.findings, ...snapshot.facts, ...snapshot.hints]) prior.set(v.id, v);
    for (const r of records) if (r.id) prior.set(r.id, r);
    let category = /^project\.|^graph\./.test(e.kind) ? "milestones" : /^finding\./.test(e.kind) ? "findings" : /^hint\.|^assets\.(approved|revoked)|^run\.retry/.test(e.kind) ? "human" : /^report\./.test(e.kind) ? "delivery" : "exploration";
    const attention = records.some(r => r.blocked_run_id || /^Execution failed:/.test(r.summary || "")) || e.kind === "job.failed";
    if (attention) category = "attention";
    const audit = /^(usage\.|evidence\.|bookmark\.|step\.(claimed|released)|decide\.conflicted)/.test(e.kind) || (e.kind === "jobs.state" && !attention);
    const observations = [...(c.facts || []), ...(c.findings || [])];
    const producer = [...records.map(r => r.step_id).filter(Boolean), ...(c.steps || []).filter((s: any) => observations.some(r => (s.fact_ids ?? []).includes(r.id))).map((s: any) => s.id)];
    const folded = /^(fact\.observed|finding\.submitted)/.test(e.kind) && producer.length && producer.every(id => completed.has(id)) && observations.length && observations.every(r => !old.has(r.id));
    if (!all && (audit || folded)) return;
    const targets = [...new Set(changedIds(c).filter(id => known.has(id)))];
    let title = activityLabels[e.kind] || e.kind;
    let detail = (c.report ? [c.report] : records).map(r => r.title || r.description || r.content || "").filter(Boolean).slice(0, 2).join("；");
    let reason = records.map(r => r.reason || r.discard_reason || "").filter(Boolean).join("；");
    let actor = records.map(r => r.creator || r.worker || r.review_worker || r.updated_by).find(Boolean) || "操作者未记录";
    const step = (c.steps || []).find((s: any) => (s.executed_at || s.concluded_at) && (e.kind === "step.executed" || e.kind === "step.completed"));
    if (step) {
      title = `${step.description} · 执行结束`;
      const facts = graph.facts.filter(f => step.fact_ids.includes(f.id));
      const findings = graph.findings.filter(f => f.step_id === step.id && f.created_at <= e.created_at);
      const evidence = graph.evidence.filter(v => v.step_id === step.id && v.created_at <= e.created_at);
      detail = `${facts.length} 条事实 · ${evidence.length} 份证据 · ${findings.length} 项发现${step.summary ? `。${step.summary}` : ""}`;
      actor = old.get(step.id)?.worker || "执行者";
      for (const r of [...facts, ...findings, ...evidence]) if (!targets.includes(r.id)) targets.push(r.id);
      reason = "";
    }
    if (e.kind === "finding.reviewed" || e.kind === "finding.reviewed.manually") {
      const r = (c.reviews || [])[0];
      if (r && !r.deleted) { title = `${graph.findings.find(f => f.id === r.finding_id)?.title || r.finding_id} · ${r.verdict === "pass" ? "审核通过" : r.verdict === "rejected" ? "审核驳回" : "需要补充证据"}`; reason = r.reason || ""; actor = r.worker || "审核者"; }
    }
    if (e.kind === "finding.submitted") {
      const f = (c.findings || [])[0];
      if (f && !f.deleted) title = `${f.title} · ${old.has(f.id) ? `修订至 v${f.version}` : "提交候选发现"}`;
    }
    if (e.kind === "project.status" && c.project) { title = c.project.status === "active" ? "启动或恢复项目" : c.project.status === "stopped" ? "暂停项目" : "项目完成"; }
    if (e.kind === "decide.committed") { const added = (c.steps || []).filter((s: any) => !old.has(s.id)); title = c.project?.pending_completion ? "搜索结束、审核中" : `探索方向已更新${added.length ? ` · 新增 ${added.length} 个任务` : ""}`; if (c.project?.pending_completion) category = "milestones"; }
    const deleted = records.filter(record => record.deletion_event);
    if (deleted.length && e.kind === "decide.committed") { title = `工作图已删除 ${deleted.length} 个节点`; detail = deleted.map(record => record.id).join("、"); }
    if (becameCompleted && !/^project\./.test(e.kind)) rows.push({ key: -e.seq, index, time: e.created_at, title: "项目最终完成", detail: "执行与审核已收敛，完成此前提出的项目目标。", actor: "系统", category: "milestones", targets: [], kind: "project.completed", reason: "" });
    rows.push({ key: e.seq, index, time: e.created_at, title, detail, actor, category, targets, kind: e.kind, reason });
  });
  return rows.reverse();
}
