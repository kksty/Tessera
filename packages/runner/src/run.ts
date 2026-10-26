import { planningRevision } from "../../protocol/src/planning.js";
import { saveEvidenceFile } from "./evidence-file.js";
import { filterFinalFacts } from "./fact-payload.js";
import { settlementBatches } from "./decision-batches.js";
import { stepAssets } from "../../protocol/src/asset-scope.js";
import { createAgentSession, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFile, mkdir, readFile, writeFile, realpath, open, stat } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolve, join, relative } from "node:path";
import type { DispatchConfig, Evidence, Fact, Graph, Job } from "../../protocol/src/index.js";
import {
  bookmarkInputSchema,
  decideSchema,
  executeSchema,
  reviewSchema,
  findingSchema,
  factSubmissionSchema,
  submitDecisionsBase,
  deletionPreviewSchema,
} from "../../protocol/src/index.js";
import { memoryEntry, queryMemory, readMemoryRecord, memoryKinds } from "../../core/src/memory.js";
import { projectionSections } from "../../core/src/projection.js";
import { coverageSurfaces } from "../../protocol/src/coverage.js";
import type { DecisionResponse } from "../../core/src/store.js";
import type { DeletionPreview } from "../../core/src/node-deletion.js";
import type { ChangesPage } from "../../core/src/memory-changes.js";
import { ApiError, ApiClient } from "./client.js";
import { SubmissionOutbox, durableJson } from "./submissions.js";
import { digest } from "../../core/src/execution.js";
import { observeModel, publicResponse, type RequestCounters } from "./model-observer.js";
import { promptFor, resultRepairPrompt } from "./prompts.js";
import { taskResources } from "./task-resources.js";
import { redactModelError } from "../../protocol/src/model-errors.js";
import { diagnosticText, diagnosticBuild, ValidationTraces, type Diagnostic } from "../../core/src/diagnostics.js";
import { Capacity } from "./capacity.js";
import { admitCloseoutTool, admitRepairTool, closeoutReads } from "./closeout.js";
import { useAtomicResult, withResultFormat } from "./result-format.js";
import { queryReferences, readReference } from "./references.js";
import { ProcessSessions, processTools } from "./process-sessions.js";
import { configuredModel, modelSettings } from "../../models/src/runtime.js";
import { repairFinalResult, validateFinalResult } from "./result-validation.js";
import { withModelRelay } from "../../models/src/relay-transport.js";

type DecisionAttempt = Pick<DecisionResponse, "settle"> & Partial<Pick<DecisionResponse, "plan" | "plan_id">>;

/**
 * Pi compression is a lossy model summary. Re-anchor the next turn on the
 * durable graph so an executor still knows which questions, Hints and leads
 * remain — without treating this text as new evidence or a new observation.
 */
function compactionAnchor(graph: Graph, job: Job): string {
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
    `未确认 Hint（${hints.length}）：${hints.join(", ") || "无"}；只有人工能关闭`,
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
  } else {
    const finding = graph.findings.find((candidate) => candidate.id === job.finding_id);
    lines.push(
      `当前 Finding：${finding ? `${finding.id} v${finding.version} ${cut(finding.title, 200)}` : (job.finding_id ?? "未知")}`,
    );
  }
  return `上下文压缩后的状态锚点（程序从共享图读取；不是新证据，也不改变已读水位）：\n${lines.join("\n")}`;
}

export function runJob(...args: Parameters<typeof runJobInternal>) {
  return withModelRelay(args[1].model_relay, args[1].model, () => runJobInternal(...args));
}

async function runJobInternal(
  job: Job,
  config: DispatchConfig,
  client = new ApiClient(config.server, process.env.TESSERA_PROJECT_TOKEN || process.env.TESSERA_WORKER_TOKEN || ""),
  workspace = "/workspace",
  recoverySession?: string,
) {
  if (recoverySession && job.kind !== "execute")
    throw new Error("Read-only session recovery currently supports Execute only");
  const timeouts = client.timeouts;
  if (recoverySession)
    await client.request(client.projectPath(job, "/jobs/heartbeat"), job, "POST", timeouts.heartbeat_timeout_ms);
  const timeLimited = config.task_timeout_seconds > 0;
  // An unlimited project must still bound an operator-driven read-only recovery,
  // otherwise its lease can be renewed forever without any exploration budget.
  const recoveryDeadline = recoverySession ? Date.now() + Math.max(1, config.closeout_seconds ?? 60) * 1000 : Infinity;
  const deadline = Math.min(timeLimited ? Date.now() + config.task_timeout_seconds * 1000 : Infinity, recoveryDeadline);
  const graph = await client.request<Graph>(client.projectPath(job));
  let memorySnapshot = graph;
  let observedGraph = graph;
  const observedBookmarks = new Map((graph.bookmarks ?? []).map((b) => [b.node_id, b]));
  const observeGraph = (full: Graph) => {
    observedGraph = full;
    observedBookmarks.clear();
    for (const b of full.bookmarks ?? []) observedBookmarks.set(b.node_id, b);
  };
  const changeInterval = { after_revision: graph.decided_revision, through_revision: graph.observation_revision };
  const { items: _changeItems, ...changes } = await client.request<ChangesPage>(
    client.projectPath(job, "/fgs/changes"),
    {
      ...changeInterval,
      limit: 0,
    },
  );
  let view = memoryEntry(graph, job, changes);
  // Decide commits through one tool; `plan_id` lets a conflicting retry skip the plan.
  let decisionPlanId: string | undefined;
  let decisionsCommitted = false;
  const directory = join(workspace, "runs", job.worker);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "view.json"), JSON.stringify({ job, view }, null, 2));
  const pending: Promise<unknown>[] = [];
  let diagnosticQueue = Promise.resolve();
  // Delivery failures never disable the channel: the local ndjson spool is the
  // durable copy, and the queue retries on the next event. Only this many
  // consecutive failures mark the Run's diagnostics as degraded.
  const DIAGNOSTIC_MAX_FAILURES = 8;
  const DIAGNOSTIC_BATCH_CAP = 256;
  let diagnosticSource = randomUUID();
  let diagnosticSequence = 0;
  const diagnosticBatch: Diagnostic[] = [];
  let diagnosticScheduled = false;
  let diagnosticFailures = 0;
  const scheduleDiagnostics = () => {
    if (diagnosticScheduled || !job.run_id) return;
    diagnosticScheduled = true;
    diagnosticQueue = diagnosticQueue.then(async () => {
      while (diagnosticBatch.length) {
        const events = diagnosticBatch.splice(0, 16);
        try {
          await client.request(
            client.projectPath(job, "/jobs/diagnostics"),
            { job, events },
            "POST",
            timeouts.diagnostics_ms,
          );
          diagnosticFailures = 0;
        } catch {
          // A short control-plane outage used to end delivery for the rest of the
          // Run, which is how the tail — the errors and repairs that matter most —
          // went missing. Keep the spool and retry with a bounded backoff.
          diagnosticFailures++;
          if (diagnosticFailures >= DIAGNOSTIC_MAX_FAILURES) {
            // Already durable in diagnostics.ndjson; dropping the in-memory copy
            // keeps the Worker bounded while the next event restarts delivery.
            console.warn(
              `Diagnostic server delivery failed ${diagnosticFailures} times; ${events.length + diagnosticBatch.length} events retained locally`,
            );
            diagnosticBatch.length = 0;
            break;
          }
          diagnosticBatch.unshift(...events);
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 300 * diagnosticFailures)));
        }
      }
      diagnosticScheduled = false;
    });
  };
  const diagnosticSecrets = [config.model.api_key, config.review_model?.api_key || "", client.token];
  const excerpt = (value: unknown, limit = 2048) => diagnosticText(value, diagnosticSecrets, limit);
  const diagnose = (type: Diagnostic["type"], data: Record<string, unknown>) => {
    const event: Diagnostic = {
      id: randomUUID(),
      at: new Date().toISOString(),
      source_id: diagnosticSource,
      source_seq: ++diagnosticSequence,
      type,
      data,
    };
    // Diagnostics cannot turn a successful exploration into a failed task.
    try {
      appendFileSync(join(directory, "diagnostics.ndjson"), JSON.stringify({ run_id: job.run_id, ...event }) + "\n", {
        mode: 0o600,
      });
    } catch {
      console.warn("Diagnostic local write failed");
    }
    if (job.run_id) {
      diagnosticBatch.push(event);
      if (diagnosticBatch.length > DIAGNOSTIC_BATCH_CAP)
        diagnosticBatch.splice(0, diagnosticBatch.length - DIAGNOSTIC_BATCH_CAP);
      scheduleDiagnostics();
    }
  };
  const traces = new ValidationTraces(diagnose, diagnosticSecrets);
  const navigationSnapshot = (phase: string, generation: number) => {
    const bookmarks = [...observedBookmarks.values()].filter((b) => !b.withdrawn_at);
    traces.record(
      "navigation_anchors",
      {
        phase,
        source: "last_program_observed_graph_and_mark_receipts",
        snapshot_revision: observedGraph.revision,
        visible_to_model: false,
        total_active: bookmarks.length,
        omitted: Math.max(0, bookmarks.length - 100),
        bookmarks: bookmarks.slice(0, 100).map((bookmark) => ({
          bookmark,
          original_record_page: readMemoryRecord(observedGraph, bookmark.node_id, 0, 4000),
        })),
      },
      { generation },
    );
  };
  diagnose("run_start", {
    kind: job.kind,
    node_id: job.step_id || job.finding_id || job.graph_id,
    diagnostics_version: 2,
    build: diagnosticBuild,
    graph_id: job.graph_id,
    snapshot_revision: graph.revision,
    observation_revision: graph.observation_revision,
    recovery: !!recoverySession,
    configured_compaction: !recoverySession,
    task_timeout_seconds: config.task_timeout_seconds,
    result_repairs: config.result_repairs ?? 1,
    trace_run_limit_chars: traces.runLimit,
    trace_limit_chars: traces.traceLimit,
    worker: job.worker,
    model: (job.kind === "review" ? config.review_model || config.model : config.model).id,
    api: (job.kind === "review" ? config.review_model || config.model : config.model).api,
    context_window: (job.kind === "review" ? config.review_model || config.model : config.model).context_window,
  });
  let captureError: Error | undefined;
  // What this Run has already persisted. The final payload may restate one of
  // these observations or name it by id; neither is a new Fact.
  const submittedFacts: { id: string; description: string }[] = [];
  const jsonResult = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    details: {},
  });
  const tool = (
    name: string,
    description: string,
    parameters: any,
    fn: (args: any) => Promise<unknown>,
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, args) => jsonResult(await fn(args)),
  });
  const p = (suffix: string) => client.projectPath(job, suffix);
  const processes =
    job.kind === "execute" && !recoverySession
      ? new ProcessSessions(join(directory, "processes"), workspace, {
          project_id: job.project_id,
          run_id: job.run_id,
          step_id: job.step_id,
          worker: job.worker,
        })
      : undefined;
  const processEvidence = new Map<string, Evidence>();
  const outbox = new SubmissionOutbox(directory, job, client, (event) =>
    diagnose("submission", {
      ...event,
      error: event.error ? excerpt(event.error) : undefined,
      request_id: currentRequest || null,
      generation: capacity?.generation ?? null,
    }),
  );
  const submit = <T = unknown>(suffix: string, data: Record<string, unknown>, final = false) =>
    decisionsCommitted && suffix !== "/fgs/decisions"
      ? Promise.reject(new Error("Decisions are committed; the Run no longer accepts this write"))
      : outbox.submit<T>(p(suffix), data, final);
  // A decision acknowledges only a projection actually returned to the model.
  // Fetching newer state internally must never authorize an older decision.
  let decisionSnapshot = graph;
  let deletionPreview: { request_hash: string; request_id: string; result: DeletionPreview } | undefined;
  const refreshDecisionView = async () => {
    decisionSnapshot = await client.request<Graph>(p("/fgs"));
    memorySnapshot = decisionSnapshot;
    observeGraph(decisionSnapshot);
    return memoryEntry(decisionSnapshot, job);
  };
  const emptySettle = (): DecisionAttempt["settle"] => ({
    ok: false,
    conflicts: [],
    closed: [],
    reopened: [],
    updated: [],
    completed: false,
    deleted: [],
    affected: [],
    cancelled_runs: [],
  });
  const decisionSubmit = async (input: Record<string, unknown>, final: boolean, initialPlanId?: string) => {
    const deletions =
      Array.isArray(input.delete_nodes) && input.delete_nodes.length
        ? deletionPreviewSchema.parse({ delete_nodes: input.delete_nodes }).delete_nodes
        : [];
    if (
      deletions.length &&
      (!deletionPreview?.result.valid ||
        deletionPreview.request_hash !== digest(deletions) ||
        deletionPreview.request_id === currentRequest)
    )
      return {
        plan_id: undefined,
        plan: undefined,
        settle: {
          ...emptySettle(),
          conflicts: [
            {
              kind: "delete" as const,
              reason:
                "Call preview_deletions with this exact delete_nodes batch and read the full impact, including shared_descendants, before submitting in a subsequent model turn. Queuing preview and submit together is insufficient. No writes were made.",
            },
          ],
        },
      };
    // A single response that grew past the settlement budget is applied in
    // ordered parts under the same Decide lease. Later parts reuse the committed
    // plan and the observation snapshot the model actually saw; none of them
    // replay the plan.
    const parts = settlementBatches(input);
    if (parts.length > 1)
      diagnose("decision_batch_split", {
        parts: parts.length,
        chars: JSON.stringify(input).length,
        finding_updates: Array.isArray(input.finding_updates) ? input.finding_updates.length : 0,
        finding_merges: Array.isArray(input.finding_merges) ? input.finding_merges.length : 0,
      });
    const aggregate = emptySettle();
    const mergeSettle = (next: DecisionAttempt["settle"]) => {
      aggregate.ok = next.ok;
      aggregate.completed ||= next.completed;
      aggregate.more = next.more;
      for (const key of ["closed", "reopened", "updated", "deleted", "affected", "cancelled_runs"] as const)
        for (const id of next[key]) if (!aggregate[key].includes(id)) aggregate[key].push(id);
      aggregate.conflicts.push(...next.conflicts);
    };
    let planId = initialPlanId;
    let planResponse: DecisionAttempt["plan"];
    for (const [index, part] of parts.entries()) {
      const body: Record<string, unknown> = {
        ...part,
        worker: job.worker,
        revision: decisionSnapshot.revision,
        observation_revision: decisionSnapshot.observation_revision,
        planning_revision: planningRevision(decisionSnapshot),
        graph_id: job.graph_id,
        // The preview hash belongs to the part that actually deletes.
        deletion_preview_hash: index === 0 && deletions.length ? deletionPreview!.result.impact_hash : undefined,
        steps: index === 0 ? (part.steps ?? []) : [],
      };
      if (index > 0) body.plan_id = planId ?? part.plan_id;
      if (initialPlanId && !(Array.isArray(body.steps) && body.steps.length)) {
        body.steps = [];
        body.plan_id = initialPlanId;
      }
      let response: DecisionAttempt;
      try {
        response = await submit<DecisionResponse>("/fgs/decisions", body, final && index === parts.length - 1);
      } catch (error) {
        // Changed Hint dependencies can reject the plan before it exists. This is
        // still a refresh conflict, not a model failure or a reason to back off.
        if (!(error instanceof ApiError && error.status === 409 && /Graph changed; refresh/.test(error.detail)))
          throw error;
        response = {
          settle: { ...emptySettle(), conflicts: [{ kind: "snapshot", reason: error.detail }] },
        };
      }
      planId ??= response.plan_id;
      planResponse ??= response.plan;
      mergeSettle(response.settle);
      if (!response.settle.ok) {
        // Earlier parts are already applied; a new decision should read the
        // current view and resubmit only the remaining settlement fields.
        deletionPreview = undefined;
        const result = { ...response, plan_id: planId, plan: planResponse, settle: aggregate };
        return final ? result : { ...result, current_view: await refreshDecisionView() };
      }
    }
    aggregate.ok = true;
    return { plan_id: planId ?? "", plan: planResponse, settle: aggregate };
  };
  const tools: ToolDefinition[] = [
    tool(
      "query_references",
      "Search the small packaged read-only reference corpus. References are guidance, never project observations or evidence. No network or target requests.",
      Type.Object({ keyword: Type.Optional(Type.String({ maxLength: 200 })) }),
      async (a) => queryReferences(a.keyword),
    ),
    tool(
      "read_reference",
      "Read a packaged reference by id with character offsets and optional expected_hash. It grants no execution permission and cannot substitute for original evidence.",
      Type.Object({
        id: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
        expected_hash: Type.Optional(Type.String()),
      }),
      async (a) => readReference(a.id, a.offset, a.limit, a.expected_hash),
    ),
    // Providers reject tool parameters whose JSON Schema is not `type: "object"`
    // (a top-level Type.Union has no type), so the active/withdrawn split lives in
    // the description and is enforced below with the server's own schema.
    tool(
      "mark_node",
      "Leave a navigation bookmark on an existing record so a later reader can find it, with the current expected_version (0 when creating). reason and revisit_when are required unless withdraw is true. Bookmarks are indexes: never evidence, approval or scheduling.",
      Type.Object({
        node_id: Type.String({ minLength: 1, maxLength: 128 }),
        expected_version: Type.Integer({ minimum: 0 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        revisit_when: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
        withdraw: Type.Optional(Type.Boolean()),
      }),
      async (a) => {
        const parsed = bookmarkInputSchema.safeParse({ ...a, worker: job.worker });
        if (!parsed.success)
          throw new Error(
            "Invalid bookmark: " +
              parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; "),
          );
        const bookmark = await submit<NonNullable<Graph["bookmarks"]>[number]>("/fgs/bookmarks", parsed.data);
        observedBookmarks.set(bookmark.node_id, bookmark);
        return bookmark;
      },
    ),
    tool(
      "read_graph",
      "Read a current work record by id with character pagination; deleted IDs return a marker. history=true explicitly reads an original historical record, without restoring it or acknowledging a current decision snapshot. Without id refreshes the current graph projection; read it before deciding from newer observations. Pass expected_hash on later pages of the same record.",
      Type.Object({
        id: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
        expected_hash: Type.Optional(Type.String()),
        history: Type.Optional(Type.Boolean()),
      }),
      async (a) => {
        if (a.history && !a.id) throw new Error("Explicit history requires a record id");
        if (!a.id) {
          if (job.kind === "decide") return refreshDecisionView();
          memorySnapshot = await client.request<Graph>(p("/fgs"));
          observeGraph(memorySnapshot);
          return memoryEntry(memorySnapshot, job);
        }
        const full = await client.request<Graph>(p(a.history ? "/fgs?history=true" : "/fgs"));
        if (!a.history) observeGraph(full);
        const record = readMemoryRecord(full, a.id, a.offset, a.limit, a.expected_hash, !!a.history);
        // A missing or stale record is a tool error, not a successful JSON result:
        // otherwise the model tends to imitate `{"error": ...}` in its final answer.
        if (record.error)
          throw new Error(
            `${record.error}: ${a.id}.${record.record_hash ? ` The record changed to ${record.record_hash}.` : ""} ` +
              "Use query_graph to find the current id or read_graph without id to refresh the view; " +
              "a tool error is not a job result.",
          );
        if (!record.deleted && !a.history) void client.request(p("/fgs/read"), { id: a.id }).catch(() => {});
        return record;
      },
    ),
    tool(
      "query_changes",
      "Page the semantic changes recorded since your previous plan. Use read_change(event_seq) for the exact stored event, read_graph for current state.",
      Type.Object({
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      }),
      async (a) =>
        client.request(p("/fgs/changes"), {
          ...changeInterval,
          ...a,
          cursor: a.cursor ?? changes.next_cursor ?? undefined,
        }),
    ),
    tool(
      "read_change",
      "Read one stored change event by event_seq with character offsets. A past event does not grant current permission.",
      Type.Object({
        event_seq: Type.Integer({ minimum: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
      }),
      async (a) => client.request(p("/fgs/changes/read"), a),
    ),
    tool(
      "query_graph",
      "Search stored history: keyword (also searches evidence bodies), asset_id, status, related_to, or a cursor-paged browse with no filter. related_to with relation=sources/outputs follows typed causal edges up/down (depth 1..3); Fact sources include producing Steps and direct Evidence, Step sources include input Facts. relations distinguish production from evidence references; provenance marks legacy producers and ambiguity, and never guesses a Run. Continue deeper from boundary IDs. Keyword hits use the current server index; a hit newer than the job snapshot refreshes that snapshot automatically. Use read_graph to read a record and read_change for exact event material. Step statuses: pending/running/blocked/executed/concluded/discarded. Finding statuses: pending/pass/needs_evidence/rejected. Assets: approved/pending/rejected, plus cooled/cold markers. status cold/hot applies only to Facts/Findings; closed Steps and Evidence are not cold — use kind=evidence or the evidence page.",
      Type.Object({
        kind: Type.Optional(Type.Union(memoryKinds.map((k) => Type.Literal(k)))),
        keyword: Type.Optional(Type.String()),
        asset_id: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        related_to: Type.Optional(Type.String()),
        relation: Type.Optional(Type.Union([Type.Literal("sources"), Type.Literal("outputs")])),
        depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
        mode: Type.Optional(Type.Union([Type.Literal("peek"), Type.Literal("query")])),
        refresh: Type.Optional(Type.Boolean()),
        history: Type.Optional(Type.Boolean()),
      }),
      async ({ refresh, ...query }) => {
        if (query.history) {
          const history = await client.request<Graph>(p("/fgs?history=true"));
          return queryMemory(history, query);
        }
        const latest = await client.request<Graph>(p("/fgs"));
        // Deletion changes membership even for an in-flight Run. Start a new
        // query snapshot so old cursors cannot skip or reintroduce removed rows.
        // This does not advance decisionSnapshot: only a returned Decide view does.
        if (JSON.stringify(latest.deleted_nodes ?? []) !== JSON.stringify(memorySnapshot.deleted_nodes ?? [])) {
          memorySnapshot = latest;
          observeGraph(memorySnapshot);
        }
        if (refresh) {
          if (query.cursor) throw new Error("刷新会开始新的检索，不要带 cursor");
          memorySnapshot = latest;
          observeGraph(memorySnapshot);
        }
        // Peek pages the cold pool, which only ever holds Facts/Findings. Any
        // other kind must fall through to the full memory query, otherwise
        // query_graph(kind=hints|goals|evidence) silently returns an empty page.
        const peekable = !query.kind || query.kind === "facts" || query.kind === "findings";
        const browse =
          peekable &&
          (query.mode === "peek" ||
            (!query.kind &&
              !query.keyword &&
              !query.asset_id &&
              !query.status &&
              !query.related_to &&
              query.mode !== "query"));
        if (browse)
          return client.request(p("/fgs/peek"), { cursor: query.cursor, limit: query.limit, kind: query.kind });
        let hits: Set<string> | undefined;
        if (query.keyword) {
          const found = await client.request<{ ids: string[] }>(p("/fgs/search"), {
            keyword: query.keyword,
            kind: query.kind,
          });
          hits = new Set(found.ids);
          // The FTS index is current, while the local query snapshot is from job
          // start. A hit missing from the snapshot means new material exists.
          const known = new Set(memoryKinds.flatMap((kind) => (memorySnapshot[kind] ?? []).map((record) => record.id)));
          if (found.ids.some((id) => !known.has(id))) {
            memorySnapshot = await client.request<Graph>(p("/fgs"));
            observeGraph(memorySnapshot);
          }
        }
        return queryMemory(memorySnapshot, { ...query, hits });
      },
    ),
    {
      name: "read_evidence",
      label: "Read evidence",
      description: "Read an original evidence record by id.",
      parameters: Type.Object({
        id: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
      }),
      execute: async (_id, args) => {
        const response = await fetch(
          config.server.replace(/\/$/, "") +
            "/api" +
            p(`/evidence/${encodeURIComponent((args as { id: string }).id)}/content`),
          {
            headers: client.token
              ? { "x-tessera-worker-token": client.token, "x-tessera-project-token": client.token }
              : {},
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok) throw new Error(`Evidence unavailable: ${response.status}`);
        // Reading the original warms the evidence node; listing metadata never does.
        void client.request(p("/fgs/read"), { id: (args as { id: string }).id }).catch(() => {});
        const bytes = Buffer.from(await response.arrayBuffer()),
          mime = response.headers.get("content-type") || "text/plain";
        if (mime.startsWith("image/"))
          return {
            content: [
              {
                type: "image" as const,
                mimeType: mime.split(";")[0],
                data: bytes.toString("base64"),
              },
            ],
            details: {},
          };
        const { offset = 0, limit = 12000 } = args as { offset?: number; limit?: number };
        const text = bytes.toString("utf8");
        return {
          content: [
            {
              type: "text" as const,
              text:
                text.slice(offset, offset + limit) +
                (offset + limit < text.length ? `\n[More evidence: use offset ${offset + limit}]` : ""),
            },
          ],
          details: {},
        };
      },
    },
  ];
  if (job.kind === "decide") {
    tools.push(
      tool(
        "preview_deletions",
        "Read the exact current impact of a proposed delete_nodes batch without changing graph, leases or decided watermarks. " +
          "Returns every deleted ID, affected retained nodes, execution/review Runs to cancel and shared_descendants that still have retained dependencies but WILL be deleted. " +
          "Call before submitting any deletion and read the complete result in the next model turn; do not queue preview and submit together. Use read_graph for unfamiliar IDs. A different batch or a changed impact requires a fresh preview. " +
          "This is not approval and does not refresh the Decide observation snapshot; use read_graph without id for a fresh full view.",
        Type.Unsafe(z.toJSONSchema(deletionPreviewSchema, { io: "input" })),
        async (raw) => {
          const body = deletionPreviewSchema.parse(raw);
          deletionPreview = undefined;
          const result = await client.request<DeletionPreview>(p("/fgs/deletions/preview"), body);
          deletionPreview = { request_hash: digest(body.delete_nodes), request_id: currentRequest, result };
          return result;
        },
      ),
    );
    const decisionParams = z.object(submitDecisionsBase.shape).strict().omit({
      worker: true,
      revision: true,
      observation_revision: true,
      planning_revision: true,
      graph_id: true,
      submission_id: true,
      plan_id: true,
      deletion_preview_hash: true,
    });
    tools.push(
      tool(
        "submit_decisions",
        "Submit decisions in one call, or in bounded parts under the same Decide run: new steps, priority updates, closes, reopens, finding_merges, finding_updates, delete_nodes, goals or complete. " +
          "If the settlement is large (roughly more than 8 finding_updates or an estimated 6000-token JSON), send the plan and Step settlement first with more:true, then finding_merges/finding_updates in further calls with more:true, and finish with complete or the last settlement without more. A part with more:true is applied and keeps the run open; only the final part ends it. A completion cannot carry more. " +
          "The runtime also splits an oversized single call into ordered parts automatically, but that cannot undo model output already generated; prefer deliberate parts. " +
          "Before deleting, call preview_deletions with the same batch and inspect all IDs, shared_descendants and cancelled_runs. " +
          "Delete work nodes with delete_nodes:[{id,reason,cascade:'none'|'downstream'}]; default none deletes only listed IDs. Downstream deletes ALL reachable dependents even if they have other retained sources, never shared Evidence or assets alone. " +
          "Deleted Findings leave current risk totals and new reports; originals, evidence, reviews and frozen reports remain in history. Deleted IDs cannot be restored. Only deleted Steps and Findings lose their execution/review leases; already sent external requests may have executed. " +
          "Merge duplicate findings with target_id, source_ids, expected_versions for every participant and reason; the target is re-reviewed and source history is retained. " +
          "Revise finding content with finding_updates: id, expected_version, reason, changes; content edits are audited and re-reviewed, never confirmed by Decide. " +
          "Use withdraw:true for non-deliverable claims; retain useful informational Findings. Restore a withdrawn ID with restore:true and changes containing new support; it becomes a new version for review. " +
          "Carry each active Hint with a Step's hint_ids, or explain in hint_notes why no Step is needed. Either way, a note is advice only and does not close the Hint; complete stays rejected until a human confirms every open Hint in the hint panel. " +
          "Before complete, account for every coverage_surfaces entry in complete.coverage: tested requires evidence_ids, waived requires a reason, na means it is not a testable surface. Omitted surfaces reject the settlement and name the missing entries. " +
          "Open leads from the view block completion: attach each to a new Step with lead_ids, or waive it in lead_dispositions with waiver_reason. " +
          "Review planning_issues also block completion: account for each in complete.review_issues with its review_id and zero-based issue_index. addressed requires a Step executed and concluded after that Review; waived requires a reason, and IDOR / authorization / PII issues can only be waived by the operator. " +
          "A successful final settlement ends the Decide run and blocks further tool calls. " +
          "New Steps are planned first and are never rolled back by a settlement conflict. Pass expected_version (the v shown in the entry) for every update/close/reopen. " +
          "If the response lists a settle conflict, read current_view, reconsider, and resend only the settlement fields with explicit current versions (omit steps); the runtime reuses the committed plan_id.",
        Type.Unsafe(z.toJSONSchema(decisionParams, { io: "input" })),
        async (raw) => {
          const input = raw as Record<string, unknown> & { steps?: unknown[] };
          const retrySettle = !!decisionPlanId && !input.steps?.length;
          const response = await decisionSubmit(
            { ...input, steps: retrySettle ? [] : (input.steps ?? []) },
            false,
            retrySettle ? decisionPlanId : undefined,
          );
          if (response.plan?.committed) decisionPlanId = response.plan_id;
          if (response.settle?.ok && !response.settle.more) decisionsCommitted = true;
          diagnose("decision_submission", {
            plan_id: response.plan_id,
            reused: response.plan?.reused ?? null,
            steps: response.plan?.steps ?? [],
            settle_ok: response.settle?.ok ?? null,
            more: response.settle?.more ?? false,
            batches: settlementBatches(input).length,
            conflicts: response.settle?.conflicts ?? [],
            completed: response.settle?.completed ?? false,
          });
          return response;
        },
      ),
    );
  }
  if (job.kind === "execute")
    tools.push(
      tool(
        "read_workspace",
        "Read an existing UTF-8 workspace file in bounded character pages; never executes it. Offset is a character offset. Binary files return metadata only.",
        Type.Object({
          path: Type.String(),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
        }),
        async ({ path, offset = 0, limit = 4000 }) => {
          const file = await realpath(resolve(workspace, path));
          const rel = relative(await realpath(workspace), file);
          if (!rel || rel.startsWith("..") || resolve(file) === resolve(workspace))
            throw new Error("File must remain inside the project workspace");
          if (!(await stat(file)).isFile()) throw new Error("Read requires a regular file");
          const handle = await open(file, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error("Read requires a regular file");
            // Decode in chunks: never load an unbounded file into memory to serve one page.
            const decoder = new TextDecoder();
            let text = "",
              seen = 0,
              binary = false;
            for await (const bytes of handle.createReadStream({ autoClose: false })) {
              if (bytes.includes(0)) {
                binary = true;
                break;
              }
              const chunk = decoder.decode(bytes, { stream: true });
              text += chunk.slice(Math.max(0, offset - seen), Math.max(0, offset + limit - seen));
              seen += chunk.length;
              if (seen >= offset + limit) break;
            }
            return binary
              ? { path, bytes: stat.size, binary: true }
              : { path, offset, text, next_offset: text.length === limit ? offset + text.length : null };
          } finally {
            await handle.close();
          }
        },
      ),
      tool(
        "submit_fact",
        "Persist an observed fact immediately. conclusion (≤120 characters) is what the fact asserts and is always shown in full; status separates positive, negative and disputed results. A not_observed fact also records request {method,url} and parameter_sources [{parameter,source,evidence_ids}] so Review can distinguish a real absence from wrong parameters.",
        // The same schema the store enforces. Rejecting here names the offending
        // field before upload, instead of a 422 after the observation was written
        // in the model's context.
        Type.Unsafe(z.toJSONSchema(factSubmissionSchema, { io: "input" })),
        async (args) => {
          const parsed = factSubmissionSchema.safeParse(args);
          if (!parsed.success)
            throw new Error(
              `Invalid fact submission: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "fact"}: ${i.message}`)
                .join("; ")}`,
            );
          const fact = await submit<Fact>(`/fgs/steps/${job.step_id}/facts`, {
            worker: job.worker,
            ...parsed.data,
          });
          submittedFacts.push({ id: fact.id, description: parsed.data.description });
          return fact;
        },
      ),
      tool(
        "submit_finding",
        "Submit or revise a candidate finding with evidence.",
        Type.Unsafe(z.toJSONSchema(findingSchema, { io: "input" })),
        async (args) => {
          // The JSON Schema cannot express cross-field identity rules; reject them
          // here with the offending field, instead of losing the submission to a 422.
          const parsed = findingSchema.safeParse(args);
          if (!parsed.success)
            throw new Error(
              `Invalid finding submission: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "finding"}: ${i.message}`)
                .join("; ")}`,
            );
          return submit(`/fgs/steps/${job.step_id}/findings`, { worker: job.worker, ...parsed.data });
        },
      ),
      tool(
        "discover_assets",
        "Record relevant discovered hosts before touching them. Only explicit target hosts and their subdomains can become pending assets; out-of-scope hosts become Facts only. Third-party links, certificates or API dependencies do not expand scope. This call never approves or tests hosts.",
        Type.Object({
          assets: Type.Array(
            Type.Object({
              hostname: Type.String(),
              source: Type.Optional(Type.String()),
              evidence_ids: Type.Optional(Type.Array(Type.String())),
            }),
          ),
        }),
        (a) =>
          submit("/assets", {
            worker: job.worker,
            assets: a.assets.map((x: { hostname: string; source?: string; evidence_ids?: string[] }) => ({
              hostname: x.hostname,
              source: x.source ?? "discovery",
              evidence_ids: x.evidence_ids ?? [],
            })),
          }),
      ),
      tool(
        "save_evidence",
        "Save an original output, request/response or image from a project workspace file. Returns its evidence id.",
        Type.Object({
          path: Type.String(),
          title: Type.String(),
          mime_type: Type.Optional(Type.String()),
        }),
        async (a) => {
          const file = resolve(workspace, a.path),
            rel = relative(resolve(workspace), file);
          if (rel.startsWith("..") || resolve(file) === resolve(workspace))
            throw new Error("Evidence must be a file in the project workspace");
          const e = await saveEvidenceFile(
            file,
            { title: a.title, step_id: job.step_id, mime_type: a.mime_type || "text/plain" },
            (body) => submit<Evidence>("/evidence", body),
          );
          return e;
        },
      ),
    );
  const cfg = job.kind === "review" ? config.review_model || config.model : config.model;
  // Pi owns request retries, output sizing and ordinary session compaction.
  // An operator-driven recovery must finish within its read-only deadline.
  const { runtime: modelRuntime, model, metadata: modelMetadata } = await configuredModel(cfg);
  const settings = modelSettings(model, !!recoverySession);
  const { loader, environment } = await taskResources(workspace, directory, settings);
  const effectiveCompaction = settings.getCompactionSettings(model);
  const capacity = new Capacity(
    model.contextWindow,
    effectiveCompaction.reserveTokens,
    effectiveCompaction.keepRecentTokens,
  );
  if (processes) tools.push(...processTools(processes));
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: directory,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: recoverySession
      ? SessionManager.open(recoverySession)
      : SessionManager.create(workspace, join(workspace, "sessions")),
    customTools: tools,
    tools: recoverySession
      ? closeoutReads
      : job.kind === "execute"
        ? ["read", "write", "edit", "bash", "grep", "find", "ls", ...tools.map((t) => t.name)]
        : tools.map((t) => t.name),
  });
  if (!recoverySession && job.kind === "execute" && job.run_id) {
    const record = {
      version: 1,
      job,
      session_path: session.sessionManager.getSessionFile(),
      workspace: resolve(workspace),
    };
    await durableJson(join(directory, "recovery.json"), { ...record, hash: digest(record) });
  }
  if (job.run_id && !recoverySession)
    await client.request(p("/jobs/started"), {
      job,
      session_path: session.sessionManager.getSessionFile() || join(workspace, "sessions"),
    });
  let leaseError: Error | undefined;
  let closing = !!recoverySession,
    repairing = !!recoverySession;
  let recoveryNeeded = false;
  const closeoutPrompt =
    "立即停止探索。可以读取已有记录与证据页面，并用 read_workspace 读取已有文件。用 save_evidence 保存工作区中已有的原始产物，用 submit_fact 提交带 evidence_ids 的已确认观测，然后返回最终 execute JSON。在 Step 摘要中记录未完成的问题和阻塞原因。不要调用 shell、发起目标请求或调用写文件工具。";
  const beginCloseout = (reason: string) => {
    if (job.kind !== "execute" || closing || leaseError) return;
    closing = true;
    // Closeout stops live commands so their raw logs become archiveable. They are
    // already stopped by submission time, so they must not block the final write.
    if (processes) void processes.close();
    diagnose("closeout", { reason: excerpt(reason), ...capacity.snapshot() });
    session.setAutoCompactionEnabled(false);
    void session.steer(reason + "\n" + closeoutPrompt).catch((error) => {
      leaseError = error;
      void session.abort();
    });
  };
  // Restrict execution as well as advertised tools: a tool batch may already be queued.
  const beforeToolCall = session.agent.beforeToolCall;
  let actionRecorded = false;
  const closeoutReserve = timeLimited
    ? Math.max(
        1,
        Math.min(
          config.closeout_seconds ?? Math.min(60, Math.floor(config.task_timeout_seconds / 3)),
          config.task_timeout_seconds - 1,
        ),
      )
    : (config.closeout_seconds ?? 60);
  const explorationDeadline = deadline - closeoutReserve * 1000;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  session.agent.beforeToolCall = async (context, signal) => {
    if (Date.now() >= explorationDeadline) beginCloseout("探索时间预算已用尽，请根据已有证据完成收尾。");
    const args = context.args as Record<string, unknown>;
    const closeoutError = closing
      ? admitCloseoutTool(context.toolCall.name, args, repairing)
      : repairing
        ? admitRepairTool(context.toolCall.name)
        : undefined;
    if (decisionsCommitted) {
      diagnose("tool_blocked", {
        request_id: currentRequest || null,
        generation: capacity.generation,
        tool_call_id: context.toolCall.id,
        tool: context.toolCall.name,
        closing,
        repairing,
        reason: "decisions_committed",
      });
      return {
        block: true,
        terminate: true,
        reason: "Decisions are already committed; stop calling tools and end the turn.",
      };
    }
    if (leaseError || closeoutError) {
      diagnose("tool_blocked", {
        request_id: currentRequest || null,
        generation: capacity.generation,
        tool_call_id: context.toolCall.id,
        tool: context.toolCall.name,
        closing,
        repairing,
        reason: closeoutError || "lease_or_cancellation",
      });
      return {
        block: true,
        terminate: !!leaseError,
        reason: closeoutError || "Closeout: return final JSON from existing material.",
      };
    }
    if (
      closeoutReads.includes(context.toolCall.name) ||
      ["read", "bash", "grep", "find", "ls", "read_reference", "query_references"].includes(context.toolCall.name)
    )
      capacity.materialAdded();
    if (context.toolCall.name === "bash") {
      if (job.kind === "execute") {
        const latest = await client.request<Graph>(client.projectPath(job));
        const step = latest.steps.find((s) => s.id === job.step_id);
        if (
          latest.project.status !== "active" ||
          !step ||
          step.discarded ||
          step.worker !== job.worker ||
          stepAssets(latest, step).some((id) => !latest.assets.some((a) => a.id === id && a.approval === "approved"))
        ) {
          return {
            block: true,
            reason: "Task or asset approval is no longer active; stop testing and preserve existing evidence.",
          };
        }
      }
      if (job.run_id && !actionRecorded) {
        await client.request(p("/jobs/action"), job);
        actionRecorded = true;
      }
      if (leaseError || signal?.aborted || closing || Date.now() >= explorationDeadline) {
        beginCloseout("记录行动权限时已达到探索时间预算。");
        return { block: true, reason: "Exploration deadline or cancellation reached before shell execution." };
      }
      const args = context.args as { timeout?: number };
      const toolLimit = config.tool_timeout_seconds ?? 0;
      const maximum = Math.max(
        1,
        Math.min(toolLimit > 0 ? toolLimit : Infinity, Math.floor((explorationDeadline - Date.now()) / 1000)),
      );
      // With no platform deadline, preserve the model's optional timeout exactly.
      // Pi's bash tool has no default timeout when this parameter is omitted.
      if (Number.isFinite(maximum))
        args.timeout = typeof args.timeout === "number" && args.timeout > 0 ? Math.min(args.timeout, maximum) : maximum;
    }
    return beforeToolCall?.(context, signal);
  };
  // A committed settlement releases the Run lease on the server. Ending the
  // turn here prevents the one extra provider request (and its 409) that used to
  // follow the settlement. Keep the session's boundary hook in the chain so
  // turn_end bookkeeping still runs.
  const finishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    const decision = await finishTurn?.(turn, signal);
    if (decisionsCommitted || leaseError) return { action: "end" as const };
    return decision ?? undefined;
  };
  let heartbeatFailures = 0,
    heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    // A committed decision already released the lease; a late heartbeat is not a failure.
    if (decisionsCommitted || heartbeatBusy || leaseError) return;
    heartbeatBusy = true;
    void client
      .request(p("/jobs/heartbeat"), job, "POST", timeouts.heartbeat_timeout_ms)
      .then(() => {
        heartbeatFailures = 0;
      })
      .catch((e) => {
        if (decisionsCommitted || leaseError) return;
        heartbeatFailures++;
        // A 409 means the server no longer knows this lease; retrying cannot help.
        // Otherwise a restart or a short network blip must not discard a long Run.
        const leaseLost = e instanceof ApiError && e.status === 409;
        if (!leaseLost && heartbeatFailures < timeouts.heartbeat_max_failures) {
          diagnose("heartbeat_retry", {
            failures: heartbeatFailures,
            error: excerpt(e instanceof Error ? e.message : e),
          });
          return;
        }
        leaseError = e;
        void processes?.close();
        void session.abort();
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, timeouts.heartbeat_interval_ms);
  const closeoutTimer = timeLimited
    ? setTimeout(
        () => beginCloseout("探索时间预算已用尽，请根据已有证据完成收尾。"),
        Math.max(0, explorationDeadline - Date.now()),
      )
    : undefined;
  const timeout = Number.isFinite(deadline)
    ? setTimeout(
        () => {
          leaseError = new Error("Task timeout");
          void session.abort();
        },
        Math.max(0, deadline - Date.now()),
      )
    : undefined;
  const terminate = () => {
    leaseError = new Error("Worker termination requested; existing evidence remains available");
    void processes?.close();
    void session.abort();
    // The signal handler supplements incremental accounting; it cannot recover provider counters never received.
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  let requestSequence = 0,
    currentRequest = "",
    telemetry = Promise.resolve();
  const flushTelemetry = async (budget: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        telemetry,
        new Promise((resolve) => {
          timer = setTimeout(resolve, budget);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const account = (requestId: string, stage: "started" | "completed", counters: RequestCounters) => {
    const payload = { job, request_id: requestId, stage, ...counters, cost: null };
    appendFileSync(join(directory, "usage.ndjson"), JSON.stringify(payload) + "\n");
    telemetry = telemetry.then(async () => {
      try {
        await client.request(p("/jobs/usage"), payload, "POST", timeouts.usage_ms);
      } catch (error) {
        // The ndjson spool above is the durable copy; never block the model request
        // chain on an accounting write.
        console.warn(
          `Usage retained locally: ${redactModelError(error instanceof Error ? error.message : "transport failure", [cfg.api_key])}`,
        );
      }
    });
  };
  const toolInputs = new Map<string, unknown>();
  const toolStarts = new Map<string, number>();
  const requestUsages = new Map<string, RequestCounters>();
  const requestPhases = new Map<string, { summary: boolean; check: boolean; generation: number }>();
  const requestTimes = new Map<string, number>();
  let requestStarted = 0;
  const atomicResult = () => !capacity.compacting && repairing && useAtomicResult(model.api, model.id);
  const observer = observeModel(session.agent.streamFunction, {
    directory,
    runId: job.run_id,
    secrets: diagnosticSecrets,
    requestPrefix: recoverySession ? `recovery_${randomUUID()}` : undefined,
    requestMetadata: () => ({ transport: atomicResult() ? "completion_json_as_sse" : "provider_stream" }),
    start: (requestId) => {
      currentRequest = requestId;
      requestSequence++;
      requestStarted = Date.now();
      requestTimes.set(requestId, requestStarted);
      const phase = capacity.compacting
        ? { summary: true, check: false, generation: capacity.generation }
        : { summary: false, ...capacity.request() };
      if (!phase.summary && recoveryNeeded) recoveryNeeded = false;
      requestPhases.set(requestId, phase);
      diagnose("model_start", {
        request_id: requestId,
        purpose: phase.summary ? "compaction" : "task",
        generation: phase.generation,
        capacity: capacity.snapshot(),
        transport: atomicResult() ? "completion_json_as_sse" : "provider_stream",
      });
      account(requestId, "started", {
        input: null,
        input_uncached: null,
        cache_read: null,
        cache_write: null,
        output: null,
      });
    },
    complete: (requestId, counters, hasToolCalls, stopReason, errorMessage) => {
      const phase = requestPhases.get(requestId);
      requestPhases.delete(requestId);
      const started = requestTimes.get(requestId);
      requestTimes.delete(requestId);
      diagnose("model_request_end", {
        request_id: requestId,
        purpose: phase?.summary ? "compaction" : "task",
        generation: phase?.generation ?? null,
        elapsed_ms: started === undefined ? null : Date.now() - started,
        ...counters,
        stop_reason: stopReason,
        error: errorMessage ? excerpt(errorMessage) : null,
        has_tool_calls: hasToolCalls,
        release_check_eligible: phase?.check ?? false,
        reserve_satisfied: phase?.check && counters.input !== null ? counters.input <= capacity.threshold : null,
      });
      if (!phase?.summary) requestUsages.set(requestId, counters);
      account(requestId, "completed", counters);
      // Usage is recorded for display only; no application-side token threshold closes a task.
    },
    failure: (requestId) => diagnose("model_capture_error", { request_id: requestId, file: "model-responses.ndjson" }),
    payload: (requestId, metadata) =>
      diagnose("model_request_payload", {
        request_id: requestId,
        ...metadata,
        stage: "sdk_payload_before_transport_adapter",
        generation: requestPhases.get(requestId)?.generation ?? null,
      }),
    response: (requestId, status) => diagnose("model_response", { request_id: requestId, status }),
    failed: (requestId, error) => {
      const started = requestTimes.get(requestId);
      requestTimes.delete(requestId);
      diagnose("model_request_error", {
        request_id: requestId,
        generation: requestPhases.get(requestId)?.generation ?? null,
        purpose: requestPhases.get(requestId)?.summary ? "compaction" : "task",
        elapsed_ms: started === undefined ? null : Date.now() - started,
        error: excerpt(error instanceof Error ? error.message : error),
      });
      requestPhases.delete(requestId);
    },
  });
  session.agent.streamFunction = withResultFormat(observer.stream, atomicResult, (completion) => {
    try {
      appendFileSync(
        join(directory, "model-responses.ndjson"),
        JSON.stringify({
          run_id: job.run_id,
          request_id: currentRequest,
          at: new Date().toISOString(),
          type: "native_completion",
          data: publicResponse(completion, diagnosticSecrets),
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      diagnose("model_capture_error", {
        request_id: currentRequest,
        file: "model-responses.ndjson",
        stage: "native_completion",
      });
    }
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start") {
      navigationSnapshot("before_compaction", capacity.generation);
      const before = capacity.snapshot();
      capacity.start();
      diagnose("compaction_start", { reason: event.reason, before, ...capacity.snapshot() });
    }
    if (event.type === "compaction_end") {
      capacity.end(!!event.result && !event.aborted && !event.errorMessage);
      // Immediately query SDK, but do not turn a post-compaction unknown into zero or an old peak.
      capacity.sample(session.getContextUsage()?.tokens);
      diagnose("compaction_end", {
        reason: event.reason,
        aborted: event.aborted,
        error: excerpt(event.errorMessage || ""),
        tokens_before: event.result?.tokensBefore,
        sdk_estimated_after: event.result?.estimatedTokensAfter,
        ...capacity.snapshot(),
      });
      if (event.result)
        traces.record("compaction_summary", event.result.summary, {
          generation: capacity.generation,
          role: "model_summary_not_evidence",
          request_id: currentRequest,
        });
      navigationSnapshot("after_compaction", capacity.generation);
      if (event.result && !decisionsCommitted && !leaseError)
        void (async () => {
          try {
            const latest = await client.request<Graph>(p("/fgs"));
            await session.steer(compactionAnchor(latest, job));
            diagnose("compaction_anchor", {
              hints: latest.hints.filter((h) => !h.withdrawn_at && !h.resolved).length,
              leads: (latest.leads ?? []).filter((lead) => lead.status === "open").length,
              surfaces: coverageSurfaces(latest).length,
            });
          } catch (error) {
            diagnose("compaction_anchor_failed", { error: excerpt(error instanceof Error ? error.message : error) });
          }
        })();
      if (!event.result && !leaseError) {
        recoveryNeeded = true;
        repairing = true;
        beginCloseout("Pi 上下文压缩失败；只能根据已有材料进行只读恢复。");
        session.setAutoCompactionEnabled(false);
        if (timeLimited)
          recoveryTimer ??= setTimeout(
            () => {
              leaseError = new Error("Read-only recovery closeout timeout; existing materials retained");
              void session.abort();
            },
            Math.min(closeoutReserve * 1000, Math.max(0, deadline - Date.now())),
          );
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (!currentRequest) currentRequest = `request_${++requestSequence}`;
      traces.record("assistant_public", publicResponse(event.message.content, diagnosticSecrets), {
        request_id: currentRequest,
        generation: capacity.generation,
        stop_reason: event.message.stopReason,
      });
      const counters = requestUsages.get(currentRequest);
      requestUsages.delete(currentRequest);
      diagnose("model_end", {
        request_id: currentRequest,
        elapsed_ms: requestStarted ? Date.now() - requestStarted : null,
        input: counters?.input_uncached ?? null,
        cache_read: counters?.cache_read ?? null,
        cache_write: counters?.cache_write ?? null,
        output: counters?.output ?? null,
        stop_reason: event.message.stopReason,
        error: excerpt(event.message.errorMessage || ""),
      });
      capacity.sample(session.getContextUsage()?.tokens, true);
      diagnose("context_usage", { request_id: currentRequest, ...capacity.snapshot() });
    }
    if (event.type === "turn_end" && event.toolResults.length) {
      capacity.sample(session.getContextUsage()?.tokens);
    }
    if (event.type === "tool_execution_start") {
      toolInputs.set(event.toolCallId, event.args);
      toolStarts.set(event.toolCallId, Date.now());
      diagnose("tool_start", {
        request_id: currentRequest,
        tool_call_id: event.toolCallId,
        generation: capacity.generation,
        closing,
        repairing,
        tool: event.toolName,
        args_excerpt: excerpt(event.args),
      });
    }
    if (event.type === "tool_execution_end") {
      const started = toolStarts.get(event.toolCallId);
      toolStarts.delete(event.toolCallId);
      const rawResult = JSON.stringify(event.result);
      diagnose("tool_end", {
        request_id: currentRequest,
        tool_call_id: event.toolCallId,
        tool: event.toolName,
        generation: capacity.generation,
        elapsed_ms: started === undefined ? null : Date.now() - started,
        is_error: event.isError,
        result_chars: rawResult.length,
        result_excerpt: excerpt(rawResult),
        raw_trace: join(directory, "tools.ndjson"),
      });
      if (
        [
          "read_graph",
          "query_graph",
          "read_evidence",
          "query_changes",
          "read_change",
          "preview_deletions",
          "mark_node",
          "read_reference",
          "query_references",
          "read_workspace",
        ].includes(event.toolName)
      )
        traces.record(
          "memory_tool",
          {
            tool: event.toolName,
            args: toolInputs.get(event.toolCallId),
            is_error: event.isError,
            result: event.result,
          },
          { generation: capacity.generation, request_id: currentRequest, tool_call_id: event.toolCallId },
        );
      // Keep the exact command/file arguments with the output, so a reviewer
      // can reproduce a download or transformation rather than guess its source.
      const content = JSON.stringify({ ...event, args: toolInputs.get(event.toolCallId) });
      toolInputs.delete(event.toolCallId);
      const saving = appendFile(join(directory, "tools.ndjson"), content + "\n").then(async () => {
        // Auxiliary reads stay local. The reference tools say so themselves
        // ("guidance, never project observations or evidence"), and archiving a
        // lookup result made its upload latency into a Run-failing error.
        if (
          [
            "read_graph",
            "query_graph",
            "query_changes",
            "read_change",
            "preview_deletions",
            "read_evidence",
            "read_reference",
            "query_references",
            "submit_fact",
            "submit_finding",
            "submit_decisions",
            "discover_assets",
            "save_evidence",
          ].includes(event.toolName)
        )
          return;
        // The settlement already ended the Run and released its lease. A late
        // archive upload would only produce "Submission does not belong to the
        // active Run"; the local tools.ndjson remains the durable record.
        if (decisionsCommitted || leaseError) return;
        await submit<Evidence>("/evidence", {
          title: `${event.toolName} tool result`,
          source_path: join(directory, "tools.ndjson"),
          step_id: job.step_id,
          content,
          mime_type: "application/json",
        });
      });
      pending.push(
        saving.catch((error) => {
          captureError = error instanceof Error ? error : new Error("Evidence recording failed");
        }),
      );
    }
  });
  let runSucceeded = false;
  try {
    const finalInstruction =
      "\n\n最终答案正文只返回一个完整 JSON 对象，不附加解释性文字或 Markdown 围栏。此格式要求仅约束最终答案正文，不限制模型原生推理通道。";
    view = memoryEntry(graph, job, changes);
    const prompt = promptFor(job, view, graph) + finalInstruction;
    // Usage and compaction are observable, but the application never gates a run on estimated tokens.
    const measurePrompt = (text: string) => {
      const projection = recoverySession ? 0 : JSON.stringify(view).length;
      const sections = projectionSections(view as Record<string, unknown>);
      diagnose("capacity_plan", {
        ...capacity.snapshot(),
        max_output: model.maxTokens,
        compaction_enabled: effectiveCompaction.enabled,
        provider: model.provider,
        api: model.api,
        entry_mode: recoverySession ? "recovery" : "task",
        projection_characters: projection,
        // Measured sections: the entry budget is tuned from these, not from guesses.
        projection_sections: {
          ...sections,
          hot: (view as Record<string, any>).cold?.hot ?? null,
          other: Math.max(0, projection - Object.values(sections).reduce((sum, value) => sum + value, 0)),
        },
        task_prompt_characters: text.length,
        task_prompt_utf8_bytes: Buffer.byteLength(text),
        context_source: modelMetadata.context_source,
        output_source: modelMetadata.output_source,
      });
      return text;
    };
    // The entry is built in full; Pi/provider compaction owns window pressure, so no character cap here.
    traces.record("initial_entry", { job, view }, { generation: capacity.generation });
    for (const kind of memoryKinds.filter((k) => k !== "bookmarks")) {
      const records = graph[kind] ?? [];
      traces.record("graph_inventory", {
        kind,
        snapshot_revision: graph.revision,
        visible_to_model: false,
        total: records.length,
        omitted: Math.max(0, records.length - 500),
        records: records.slice(0, 500).map((item) => {
          const r = item as unknown as Record<string, unknown>;
          const text = String(r.description ?? r.content ?? r.title ?? r.reason ?? r.summary ?? r.hostname ?? "");
          const links = Object.fromEntries(
            ["from", "evidence_ids", "fact_ids", "source_fact_ids"]
              .filter((key) => Array.isArray(r[key]))
              .map((key) => [key, { total: (r[key] as unknown[]).length, ids: (r[key] as unknown[]).slice(0, 200) }]),
          );
          return {
            id: r.id,
            graph_id: r.graph_id,
            record_hash: digest(r),
            preview: text.slice(0, 600),
            preview_truncated: text.length > 600,
            status: r.status ?? r.state ?? r.approval ?? r.review_status ?? null,
            version: r.version ?? null,
            sha256: r.sha256 ?? null,
            ...links,
          };
        }),
      });
    }
    navigationSnapshot("initial", capacity.generation);
    traces.record("runtime_policy", {
      build: diagnosticBuild,
      compaction: effectiveCompaction,
      enabled: effectiveCompaction.enabled,
      tool_names: session.agent.state.tools.map((t) => t.name),
      environment_sha256: digest(environment),
      task_timeout_seconds: config.task_timeout_seconds,
      closeout_seconds: closeoutReserve,
      tool_timeout_seconds: config.tool_timeout_seconds ?? 0,
      result_repairs: config.result_repairs ?? 1,
      model_id: model.id,
      api: model.api,
      context_window: model.contextWindow,
    });
    await writeFile(join(directory, "view.json"), JSON.stringify({ job, view }, null, 2));
    await session.prompt(
      measurePrompt(
        recoverySession
          ? "只读恢复：读取已有记录、证据和工作区文件，不执行命令、不发起目标请求、不写文件、不提交新事实。根据已有证据返回最终 JSON，说明未完成的问题和阻塞原因。"
          : prompt + (closing ? `\n\n${closeoutPrompt}` : ""),
      ),
    );
    if (decisionsCommitted) {
      await Promise.all(pending);
      // The decision is already committed; a late heartbeat/lease error cannot undo it.
      if (captureError) throw captureError;
      runSucceeded = true;
      return;
    }
    if (recoveryNeeded && !leaseError) {
      recoveryNeeded = false;
      await session.prompt(
        "只读恢复：只读取已有材料，不提交新事实、不写文件、不执行命令、不发起目标请求。根据已有证据返回任务最终 JSON，如实说明阻塞原因。",
      );
    }
    await Promise.all(pending);
    if (leaseError) throw leaseError;
    if (captureError) throw captureError;
    // Only a command that is still running when the model submits means the Step
    // is unfinished. Commands stopped by closeout were already handled above.
    const runningAtSubmit = processes ? await processes.close() : [];
    const last = session.messages.filter((m) => m.role === "assistant").at(-1);
    if (last?.stopReason === "error")
      throw new Error(
        `Model provider failure: ${redactModelError(last.errorMessage || last.stopReason, [cfg.api_key])}`,
      );
    if (!session.getLastAssistantText()) throw new Error("Model provider failure: empty final response");
    const payload = await repairFinalResult({
      job,
      config,
      deadline,
      key: cfg.api_key,
      text: () => session.getLastAssistantText(),
      stopReason: () => session.messages.filter((m) => m.role === "assistant").at(-1)?.stopReason,
      leaseError: () => leaseError,
      validate: (text) => validateFinalResult(job, graph, () => client.request<Graph>(client.projectPath(job)), text),
      trace: (text, repair) => {
        traces.record("final_parse_input", text, {
          request_id: currentRequest,
          repair,
          generation: capacity.generation,
        });
        try {
          appendFileSync(
            join(directory, "model-responses.ndjson"),
            JSON.stringify({
              run_id: job.run_id,
              request_id: currentRequest,
              at: new Date().toISOString(),
              type: "parse_input",
              data: publicResponse({ text, repair }, diagnosticSecrets),
            }) + "\n",
            { mode: 0o600 },
          );
        } catch {
          diagnose("model_capture_error", {
            request_id: currentRequest,
            file: "model-responses.ndjson",
            stage: "parse_input",
          });
        }
      },
      diagnose: (type, data) =>
        diagnose(type, { ...data, request_id: currentRequest, generation: capacity.generation }),
      repair: async (detail) => {
        // Execute repair is a closeout: no further world actions. Decide and
        // Review repair still need their read-only graph tools; admitRepairTool
        // blocks writes while `closing` stays false so the gate message does not
        // describe an Execute closeout that never happened.
        if (job.kind === "execute") closing = true;
        repairing = true;
        session.setAutoCompactionEnabled(false);
        await session.prompt(resultRepairPrompt(job, detail));
        if (leaseError) throw leaseError;
        const repaired = session.messages.filter((m) => m.role === "assistant").at(-1);
        if (repaired?.stopReason === "error")
          throw new Error(
            `Model provider failure: ${redactModelError(repaired.errorMessage || repaired.stopReason, [cfg.api_key])}`,
          );
      },
    });
    const validate = <T>(parse: () => T): T => {
      try {
        return parse();
      } catch {
        throw new Error("Model provider failure: final JSON does not match the job protocol");
      }
    };
    // Validate before recording successful usage, so malformed replies cannot reset failure backoff.
    const decision =
      job.kind === "decide"
        ? validate(() =>
            decideSchema.parse({
              ...payload,
              worker: job.worker,
              revision: graph.revision,
              observation_revision: graph.observation_revision,
              graph_id: job.graph_id,
            }),
          )
        : undefined;
    const review =
      job.kind === "review"
        ? validate(() =>
            reviewSchema.parse({
              ...payload,
              worker: job.worker,
              finding_version: job.finding_version,
            }),
          )
        : undefined;
    const execution =
      job.kind === "execute" ? validate(() => executeSchema.parse({ ...payload, worker: job.worker })) : undefined;
    traces.record("final_payload", decision ?? review ?? execution, {
      request_id: currentRequest,
      generation: capacity.generation,
    });
    await flushTelemetry(timeouts.usage_ms);
    if (job.kind === "decide") {
      // The final-JSON fallback uses the same plan/settle contract as the tool, so
      // versions, assets and idempotency are enforced and a plan survives conflicts.
      const response = await decisionSubmit(decision!, true, decisionPlanId);
      if (!response.settle?.ok) {
        // Release without a failure/backoff so the scheduler can plan from fresh
        // observations on its next pass; planned Steps remain as evidence of intent.
        await client.request(p("/jobs/release"), { job, conflict: true });
        diagnose("decision_submission", {
          plan_id: response.plan_id,
          reused: response.plan?.reused ?? null,
          steps: response.plan?.steps ?? [],
          settle_ok: false,
          conflicts: response.settle?.conflicts ?? [],
          completed: false,
        });
      }
    } else if (job.kind === "review") await submit(`/findings/${job.finding_id}/review`, review!, true);
    else {
      const data = execution!;
      // A read-only recovery session may not smuggle new observations through its
      // final payload; only the summary of what was already recorded is writable.
      if (recoverySession) {
        data.facts = [];
        data.findings = [];
        data.leads = [];
        data.read_only = true;
        data.summary += "\n只读恢复：未写入新事实、发现或线索，也不把 Step 记为已执行；仅根据已有材料收尾。";
      }
      if (processes) {
        for (const row of processes.list()) {
          const evidence = await saveEvidenceFile(
            row.log_path,
            {
              title: `Shell process ${row.process_id} raw output`,
              step_id: job.step_id,
              mime_type: "application/octet-stream",
            },
            (body) => submit<Evidence>("/evidence", body),
          );
          processEvidence.set(row.process_id, evidence);
        }
        if (processEvidence.size)
          data.summary += `\n进程原始输出：${[...processEvidence].map(([id, evidence]) => `${id} → ${evidence.id}`).join("；")}。`;
        if (runningAtSubmit.length)
          throw new Error(
            `Execution incomplete: 提交结果时仍有运行中的进程，已停止且未自然完成：${runningAtSubmit.join("、")}。原始输出已保存；Step 不记为完成。`,
          );
      }
      // Legacy string observations carry no attribution. Never guess their
      // evidence from the most recent (potentially unrelated) tool calls.
      // Restating what this Run already persisted, or naming it by id ("f002"),
      // refers to existing nodes; written as facts they become Fact rows whose
      // body is an identifier and that Decide then has to delete again.
      const { facts: finalFacts, filtered } = filterFinalFacts(
        data.facts,
        [
          ...(graph.facts ?? []).map((f) => f.id),
          ...(graph.steps ?? []).map((s) => s.id),
          ...(graph.findings ?? []).map((f) => f.id),
          ...submittedFacts.map((f) => f.id),
        ],
        submittedFacts.map((f) => f.description),
      );
      data.facts = finalFacts as typeof data.facts;
      if (filtered.reference || filtered.duplicate)
        diagnose("fact_payload_filtered", {
          ...filtered,
          submitted: submittedFacts.length,
          note: "existing nodes are referenced, not re-submitted; only new observations become Facts",
        });
      await submit(`/fgs/steps/${job.step_id}/execute`, data, true);
    }
    runSucceeded = true;
  } catch (error) {
    diagnose("run_end", {
      outcome: "error",
      error: excerpt(error instanceof Error ? error.message : error),
      trace_chars: traces.chars,
      omitted_traces: traces.omitted,
      diagnostic_delivery_failed: diagnosticFailures > 0,
    });
    throw error;
  } finally {
    if (processes) {
      await processes.close();
      // Failure/lease loss may prevent server writes; raw logs and metadata remain
      // in the persistent workspace even when archival cannot be accepted.
      for (const row of processes.list())
        if (!processEvidence.has(row.process_id)) {
          try {
            const evidence = await saveEvidenceFile(
              row.log_path,
              {
                title: `Shell process ${row.process_id} raw output`,
                step_id: job.step_id,
                mime_type: "application/octet-stream",
              },
              (body) => submit<Evidence>("/evidence", body),
            );
            processEvidence.set(row.process_id, evidence);
          } catch {
            /* Original log remains durable; never conceal the Run error. */
          }
        }
    }
    if (runSucceeded)
      diagnose("run_end", {
        outcome: "returned",
        trace_chars: traces.chars,
        omitted_traces: traces.omitted,
        diagnostic_delivery_failed: diagnosticFailures > 0,
        note: "See server Run snapshot for final commit/conflict status; returned does not imply semantic fidelity",
      });
    clearInterval(heartbeat);
    clearTimeout(timeout);
    clearTimeout(closeoutTimer);
    clearTimeout(recoveryTimer);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
    await flushTelemetry(Math.min(5000, timeouts.usage_ms));
    let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        diagnosticQueue,
        new Promise((resolve) => {
          diagnosticTimer = setTimeout(resolve, Math.min(5000, timeouts.diagnostics_ms));
        }),
      ]);
    } finally {
      clearTimeout(diagnosticTimer);
    }
    unsubscribe();
    session.dispose();
  }
}
