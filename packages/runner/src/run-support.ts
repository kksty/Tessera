import type { Graph, Job } from "../../protocol/src/index.js";
import { coverageSurfaces } from "../../protocol/src/coverage.js";

export function compactionAnchor(graph: Graph, job: Job): string {
  const cut = (value: string, limit = 160) => (value.length > limit ? value.slice(0, limit) + "…" : value);
  const open = graph.steps.filter((step) => !step.deleted && !step.concluded_at && !step.discarded);
  const hints = graph.hints.filter((hint) => !hint.withdrawn_at && !hint.resolved).map((hint) => hint.id);
  const leads = (graph.leads ?? [])
    .filter((lead) => lead.status === "open")
    .map((lead) => `${lead.id} ${lead.surface}${lead.parameter ? ` (${lead.parameter})` : ""}: ${cut(lead.why, 120)}`);
  const coverage = coverageSurfaces(graph).map((item) => item.surface);
  const pending = graph.findings.filter(
    (finding) =>
      !finding.deleted &&
      !finding.merged_into &&
      !finding.withdrawn_at &&
      finding.review_status === "pending" &&
      finding.version > finding.reviewed_version,
  );
  const lines = [
    `目标：${cut(graph.goals.find((goal) => goal.id === "goal")?.description ?? "", 300)}`,
    `未处置 Hint（${hints.length}）：${hints.join(", ") || "无"}；用 hint_notes 说明落实或由人工确认`,
    `open leads（${leads.length}）：${leads.join(" | ") || "无"}`,
    `已观测 surface（${coverage.length}）：${coverage.slice(0, 30).join(", ") || "无"}`,
    `待审 Finding（${pending.length}）：${
      pending
        .slice(0, 12)
        .map((finding) => `${finding.id} v${finding.version}`)
        .join(", ") || "无"
    }`,
  ];
  if (job.kind === "decide")
    lines.push(
      `未关闭 Step（${open.length}）：${
        open
          .slice(0, 20)
          .map((step) => `${step.id} ${cut(step.description, 100)}`)
          .join(" | ") || "无"
      }`,
    );
  else if (job.kind === "execute") {
    const step = open.find((candidate) => candidate.id === job.step_id);
    lines.push(`当前 Step：${step ? `${step.id} ${cut(step.description, 200)}` : (job.step_id ?? "未知")}`);
    if (step?.property) lines.push(`必须回应的属性：${cut(step.property, 300)}`);
  } else if (job.kind === "peer") {
    // swarm 没有 Step/Finding：压缩后仍要让执行者知道自己是谁、同伴在追什么、
    // 以及是否有一轮待表态的共识。
    const peers = (graph.peers ?? [])
      .filter((peer) => peer.status === "active")
      .map((peer) => `${peer.id}${peer.direction ? `（${cut(peer.direction, 60)}）` : ""}`);
    lines.push(`当前执行者：${job.peer_id ?? "未知"}`);
    const recent = graph.facts.filter((fact) => !fact.deleted && fact.status === "not_observed").slice(-8);
    lines.push(
      `最近负向观测（按 ID 回读范围与原文）：${recent.map((fact) => `${fact.id} 证据:${fact.evidence_ids.slice(0, 3).join(",") || "未引用"}`).join(" | ") || "无"}`,
    );
    lines.push(`在岗执行者：${peers.join("、") || "无"}`);
    const round = (graph.rounds ?? []).find((candidate) => candidate.status === "open");
    lines.push(
      round
        ? `开放共识轮次 ${round.id}（发起者 ${round.proposer_peer_id}）：已表态 ${
            Object.keys(round.opinions ?? {}).length
          }/${round.peer_ids.length}`
        : "当前没有开放共识轮次",
    );
  } else {
    const finding = graph.findings.find((candidate) => candidate.id === job.finding_id);
    lines.push(
      `当前 Finding：${finding ? `${finding.id} v${finding.version} ${cut(finding.title, 200)}` : (job.finding_id ?? "未知")}`,
    );
  }
  return `上下文压缩后的状态锚点（程序从共享图读取；不是新证据，也不改变已读水位）：\n${lines.join("\n")}`;
}

export function peerEntry(
  graph: Graph,
  swarm: {
    peers?: { id: string; status?: string; direction?: string; state?: { wake?: string; turns?: number } }[];
    rounds?: {
      id: string;
      proposer_peer_id: string;
      peer_ids: string[];
      status: string;
      opinions: Record<string, { opinion: string }>;
      reason?: string;
    }[];
    /** 当前未处置的 Review 问题；完成共识必须逐条 addressed/waived。 */
    review_issues?: { review_id: string; issue_index: number; risk: string; issue: string }[];
    /** 自该 peer 的 seen_revision 以来的图变化（服务端按事件日志生成）。 */
    changes?: {
      kind: string;
      id: string;
      revision: number;
      event_kind: string;
      preview: string;
      deleted?: boolean;
    }[];
    changes_total?: number;
    changes_remaining?: number;
    since_revision?: number;
  },
  inbox: {
    id: string;
    seq: number;
    from_peer: string | null;
    kind: string;
    body: string;
    refs: string[];
    created_at: string;
  }[],
  peerId: string,
) {
  const cut = (value: string | undefined, limit = 400) =>
    (value ?? "").length > limit ? (value ?? "").slice(0, limit) + "…" : (value ?? "");
  const me = (swarm.peers ?? []).find((p) => p.id === peerId);
  const activeFacts = graph.facts.filter((f) => !f.deleted);
  const activeFindings = graph.findings.filter((f) => !f.deleted && !f.merged_into && !f.withdrawn_at);
  const round = (swarm.rounds ?? []).find((r) => r.status === "open");
  return {
    mode: "swarm",
    role: "peer",
    me: me ? { id: me.id, direction: me.direction, wake: me.state?.wake, turns: me.state?.turns } : { id: peerId },
    goal: graph.goals
      .filter((g) => !g.deleted && g.state === "active")
      .map((g) => ({ id: g.id, description: g.description })),
    hints: graph.hints
      .filter((h) => !h.withdrawn_at && !h.resolved)
      .map((h) => ({ id: h.id, content: cut(h.content, 300) })),
    peers: (swarm.peers ?? [])
      .filter((p) => p.id !== peerId)
      .map((p) => ({ id: p.id, status: p.status, direction: p.direction, wake: p.state?.wake, turns: p.state?.turns })),
    inbox: inbox.map((m) => ({
      id: m.id,
      seq: m.seq,
      from: m.from_peer ?? "runtime",
      kind: m.kind,
      body: cut(m.body, 800),
      refs: m.refs,
      at: m.created_at,
    })),
    shared: {
      fact_count: activeFacts.length,
      facts: activeFacts.slice(-200).map((f) => ({
        id: f.id,
        conclusion: cut(f.conclusion || f.description, 240),
        status: f.status,
        objects: f.objects,
        // A negative fact is only usable with its boundary; peers must not
        // inherit "not observed once" as "the direction is exhausted".
        request: f.request ? { method: cut(f.request.method, 20), url: cut(f.request.url, 500) } : null,
        evidence_ids: f.evidence_ids.slice(0, 5),
        evidence_truncated: f.evidence_ids.length > 5,
        run_id: f.run_id ?? null,
        negative_scope: f.negative_scope
          ? {
              attempted: f.negative_scope.attempted.slice(0, 2).map((item) => cut(item, 120)),
              not_tested: f.negative_scope.not_tested?.slice(0, 2).map((item) => cut(item, 120)) ?? null,
              confidence: f.negative_scope.confidence,
              truncated:
                f.negative_scope.attempted.length > 2 ||
                (f.negative_scope.not_tested?.length ?? 0) > 2 ||
                [...f.negative_scope.attempted, ...(f.negative_scope.not_tested ?? [])].some(
                  (item) => item.length > 120,
                ),
            }
          : null,
      })),
      finding_count: activeFindings.length,
      findings: activeFindings.slice(-100).map((f) => ({
        id: f.id,
        title: cut(f.title, 160),
        kind: f.kind ?? null,
        status: f.status,
        review_status: f.review_status,
        severity: f.severity ?? null,
      })),
    },
    // 自上次回合结束以来共享图真正发生的变化。之前这里只给最近 200 条 Fact /
    // 100 条 Finding，同伴的中途写入很容易被挤出窗口；变化摘要按 seen_revision
    // 生成，是完成共识前核对“别人做了什么”的最小增量。
    changes_since_seen: {
      since_revision: swarm.since_revision ?? null,
      total: swarm.changes_total ?? 0,
      remaining: swarm.changes_remaining ?? 0,
      items: (swarm.changes ?? []).map((change) => ({
        kind: change.kind,
        id: change.id,
        revision: change.revision,
        event: change.event_kind,
        preview: cut(change.preview, 180),
        ...(change.deleted ? { deleted: true } : {}),
      })),
    },
    review_issues: (swarm.review_issues ?? []).map((item) => ({
      review_id: item.review_id,
      issue_index: item.issue_index,
      risk: item.risk,
      issue: cut(item.issue, 300),
    })),
    round: round
      ? {
          id: round.id,
          proposer: round.proposer_peer_id,
          participants: round.peer_ids,
          reason: round.reason,
          opinions: round.opinions,
          your_opinion: round.opinions[peerId]?.opinion ?? null,
        }
      : null,
  };
}
