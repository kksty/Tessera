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
