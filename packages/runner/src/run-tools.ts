import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { open, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  bookmarkInputSchema,
  deletionPreviewSchema,
  factRevisionSchema,
  factSubmissionSchema,
  findingSchema,
  submitDecisionsBase,
} from "../../protocol/src/index.js";
import type { ChangesPage } from "../../core/src/memory-changes.js";
import type { DeletionPreview } from "../../core/src/node-deletion.js";
import type { DecisionResponse } from "../../core/src/store.js";
import type { Diagnostic } from "../../core/src/diagnostics.js";
import { digest } from "../../core/src/execution.js";
import { memoryEntry, memoryKinds, queryMemory, readMemoryRecord } from "../../core/src/memory.js";
import type { DispatchConfig, Evidence, Fact, Graph, Job } from "../../protocol/src/index.js";
import type { ApiClient } from "./client.js";
import { settlementBatches } from "./decision-batches.js";
import { saveEvidenceFile } from "./evidence-file.js";
import { queryReferences, readReference } from "./references.js";

type DecisionAttempt = Pick<DecisionResponse, "settle"> & Partial<Pick<DecisionResponse, "plan" | "plan_id">>;

/**
 * Everything the run-scoped tool table needs from the surrounding Run. The table is
 * plain configuration; handlers receive the same closures the inline table used to
 * capture, plus accessors for the few Run locals they mutate.
 */
export interface RunToolsContext {
  job: Job;
  config: DispatchConfig;
  client: ApiClient;
  workspace: string;
  p: (suffix: string) => string;
  peerBase: string;
  changeInterval: { after_revision: number; through_revision: number };
  changes: Omit<ChangesPage, "items">;
  submittedFacts: { id: string; description: string }[];
  observedBookmarks: Map<string, NonNullable<Graph["bookmarks"]>[number]>;
  observeGraph: (full: Graph) => void;
  refreshDecisionView: () => Promise<unknown>;
  decisionSubmit: (input: Record<string, unknown>, final: boolean, initialPlanId?: string) => Promise<DecisionAttempt>;
  submit: <T = unknown>(suffix: string, data: Record<string, unknown>, final?: boolean) => Promise<T>;
  diagnose: (type: Diagnostic["type"], data: Record<string, unknown>) => void;
  getMemorySnapshot: () => Graph;
  setMemorySnapshot: (graph: Graph) => void;
  setDeletionPreview: (
    value: { request_hash: string; request_id: string; result: DeletionPreview } | undefined,
  ) => void;
  getDecisionPlanId: () => string | undefined;
  setDecisionPlanId: (value: string | undefined) => void;
  setDecisionsCommitted: (value: boolean) => void;
  getCurrentRequest: () => string;
}

/** Build the Run's custom tool table. Pure configuration: no I/O happens until a tool is called. */
export function createRunTools(ctx: RunToolsContext): ToolDefinition[] {
  const {
    job,
    config,
    client,
    workspace,
    p,
    peerBase,
    changeInterval,
    changes,
    submittedFacts,
    observedBookmarks,
    observeGraph,
    refreshDecisionView,
    decisionSubmit,
    submit,
    diagnose,
    getMemorySnapshot,
    setMemorySnapshot,
    setDeletionPreview,
    getDecisionPlanId,
    setDecisionPlanId,
    setDecisionsCommitted,
    getCurrentRequest,
  } = ctx;

  const factInputSchema =
    job.kind === "peer"
      ? factSubmissionSchema.extend({ asset_id: z.string().trim().min(1).optional() })
      : factSubmissionSchema;

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
      "Read a current work record by id with character pagination; deleted IDs return a deletion marker without their original content. Without id returns the current graph projection. Pass expected_hash on later pages of the same record.",
      Type.Object({
        id: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
        expected_hash: Type.Optional(Type.String()),
      }),
      async (a) => {
        if ((a as { history?: unknown }).history !== undefined)
          throw new Error(
            "Historical records are operator-only; read_graph returns the current record. Use the current graph or query_graph for active ids.",
          );
        if (!a.id) {
          if (job.kind === "decide") return refreshDecisionView();
          setMemorySnapshot(await client.request<Graph>(p("/fgs")));
          observeGraph(getMemorySnapshot());
          return memoryEntry(getMemorySnapshot(), job);
        }
        const full = await client.request<Graph>(p("/fgs"));
        observeGraph(full);
        const record = readMemoryRecord(full, a.id, a.offset, a.limit, a.expected_hash);
        // A missing or stale record is a tool error, not a successful JSON result:
        // otherwise the model tends to imitate `{"error": ...}` in its final answer.
        if (record.error)
          throw new Error(
            `${record.error}: ${a.id}.${record.record_hash ? ` The record changed to ${record.record_hash}.` : ""} ` +
              "Use query_graph to find the current id or read_graph without id to refresh the view; " +
              "a tool error is not a job result.",
          );
        if (!record.deleted) void client.request(p("/fgs/read"), { id: a.id }).catch(() => {});
        return record;
      },
    ),
    tool(
      "query_changes",
      "Page the semantic changes recorded since your previous plan. Rows carry event_seq and a cursor for the next page.",
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
      "Search the current graph: keyword (also searches evidence bodies), asset_id, status, related_to, or a cursor-paged browse with no filter. related_to with relation=sources/outputs follows typed causal edges up/down (depth 1..3); Fact sources include producing Steps and direct Evidence, Step sources include input Facts. relations distinguish production from evidence references; provenance marks legacy producers and ambiguity, and never guesses a Run. Keyword hits use the current server index; a hit newer than the job snapshot refreshes that snapshot automatically. Step statuses: pending/running/blocked/executed/concluded/discarded. Finding statuses: pending/pass/needs_evidence/rejected. Assets: approved/pending/rejected, plus cooled/cold markers. status cold/hot applies only to Facts/Findings; closed Steps and Evidence are not cold — use kind=evidence or the evidence page. Deleted records and older versions are excluded.",
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
      }),
      async ({ refresh, ...query }) => {
        if ((query as { history?: unknown }).history !== undefined)
          throw new Error(
            "Historical records are operator-only; query_graph searches the current graph. Deleted records and older versions are not readable from a Run.",
          );
        const latest = await client.request<Graph>(p("/fgs"));
        // Deletion changes membership even for an in-flight Run. Start a new
        // query snapshot so old cursors cannot skip or reintroduce removed rows.
        // This does not advance decisionSnapshot: only a returned Decide view does.
        if (JSON.stringify(latest.deleted_nodes ?? []) !== JSON.stringify(getMemorySnapshot().deleted_nodes ?? [])) {
          setMemorySnapshot(latest);
          observeGraph(getMemorySnapshot());
        }
        if (refresh) {
          if (query.cursor) throw new Error("刷新会开始新的检索，不要带 cursor");
          setMemorySnapshot(latest);
          observeGraph(getMemorySnapshot());
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
          const known = new Set(
            memoryKinds.flatMap((kind) => (getMemorySnapshot()[kind] ?? []).map((record) => record.id)),
          );
          if (found.ids.some((id) => !known.has(id))) {
            setMemorySnapshot(await client.request<Graph>(p("/fgs")));
            observeGraph(getMemorySnapshot());
          }
        }
        return queryMemory(getMemorySnapshot(), { ...query, hits });
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
  // `revise_fact` is bookkeeping, not exploration: it edits an existing Fact's
  // wording or provenance in place so neither Decide nor Execute has to open a
  // zero-request Step just to restate what is already known.
  if (job.kind === "decide" || job.kind === "execute")
    tools.push(
      tool(
        "revise_fact",
        "Revise an existing Fact in place instead of opening a bookkeeping Step: correct counts or wording, add the request/parameter_sources provenance or negative_scope a negative claim was missing, or attach evidence archived later. Cannot change status or the origin Fact; each changed field keeps the replaced value.",
        Type.Unsafe(z.toJSONSchema(factRevisionSchema.extend({ fact_id: z.string().trim().min(1) }), { io: "input" })),
        async (args) => {
          const parsed = factRevisionSchema.extend({ fact_id: z.string().trim().min(1) }).safeParse(args);
          if (!parsed.success)
            throw new Error(
              `Invalid fact revision: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "revision"}: ${i.message}`)
                .join("; ")}`,
            );
          const { fact_id, ...changes } = parsed.data;
          return submit<Fact>(`/fgs/facts/${encodeURIComponent(fact_id)}/revisions`, {
            worker: job.worker,
            ...changes,
          });
        },
      ),
    );
  if (job.kind === "decide") {
    tools.push(
      tool(
        "preview_deletions",
        "Read the exact current impact of a proposed delete_nodes batch without changing graph, leases or decided watermarks. " +
          "Returns every deleted ID, affected retained nodes, execution/review Runs to cancel and shared_descendants that still have retained dependencies but WILL be deleted. " +
          "A preview is bound to that exact batch; a different batch or a changed impact invalidates it. " +
          "This is not approval and does not refresh the Decide observation snapshot.",
        Type.Unsafe(z.toJSONSchema(deletionPreviewSchema, { io: "input" })),
        async (raw) => {
          const body = deletionPreviewSchema.parse(raw);
          setDeletionPreview(undefined);
          const result = await client.request<DeletionPreview>(p("/fgs/deletions/preview"), body);
          setDeletionPreview({ request_hash: digest(body.delete_nodes), request_id: getCurrentRequest(), result });
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
          "New Steps belong in steps[] with from/description/property; updates[] only addresses existing Step ids and every entry needs id. An unstarted Step can be refined in place through updates description/property/method_hint/from; a near-duplicate of an open Step is merged into it instead of creating a second Step. " +
          "Large settlements can be sent in ordered parts with more:true: plan and Step settlement first, then finding_merges/finding_updates, and finish with complete or the last settlement without more. A part with more:true is applied and keeps the run open; only the final part ends it. A completion cannot carry more. " +
          "The runtime also splits an oversized single call into ordered parts automatically, but that cannot undo model output already generated. " +
          "delete_nodes takes [{id,reason,cascade:'none'|'downstream'}]; default none deletes only the listed IDs, downstream deletes ALL reachable dependents even if they have other retained sources, and never shared Evidence or assets alone. " +
          "Deleted Findings leave current risk totals and new reports; originals, evidence, reviews and frozen reports remain, and the operator can restore a deleted Finding ID. Deleted Facts, Steps and subgoals keep history only. An operator-approved Finding cannot be deleted; withdraw or revise it instead. Only deleted Steps and Findings lose their execution/review leases; already sent external requests may have executed. " +
          "finding_merges takes target_id, source_ids, expected_versions for every participant and reason; the target is re-reviewed and source history is retained. " +
          "finding_updates takes id, expected_version, reason and changes; content edits are audited and re-reviewed, never confirmed by Decide. " +
          "withdraw:true withdraws a Finding; restore:true with changes restores a withdrawn ID as a new version for review. An operator-approved current version cannot be withdrawn or merged away as a source; the operator must withdraw the approval first. " +
          "hint_ids on a Step carries an active Hint; a hint_notes entry that states how the directive was handled closes it (the Decider may settle it this way), and a human can still confirm or withdraw it in the hint panel. " +
          "complete.coverage accounts for every coverage_surfaces entry: tested requires evidence_ids, waived requires a reason, na means it is not a testable surface. Omitted surfaces reject the settlement and name the missing entries. " +
          "Open leads are advisory candidates, not a completion gate: pursue one with a new Step's lead_ids (subject to the per-round budget), or record lead_dispositions.waiver_reason to dismiss it; leaving the rest is allowed. " +
          "Review planning_issues block completion too: complete.review_issues accounts for each with its review_id and zero-based issue_index. addressed requires a Step executed and concluded after that Review; waived requires a reason, and IDOR / authorization / PII issues can only be waived by the operator. " +
          "A successful final settlement ends the Decide run and blocks further tool calls. " +
          "Each round may create at most max_new_steps_per_round Steps and the open queue has a cap; a plan that exceeds either is rejected, so close or discard unfinished Steps before queueing more. " +
          "Use revise_fact to fix an existing Fact's wording, counts or request/parameter_sources instead of opening a zero-request bookkeeping Step. " +
          "New Steps are planned first and are never rolled back by a settlement conflict. Pass expected_version (the v shown in the entry) for every update/close/reopen. " +
          "If the response lists a settle conflict, read current_view, reconsider, and resend only the settlement fields with explicit current versions (omit steps); the runtime reuses the committed plan_id.",
        Type.Unsafe(z.toJSONSchema(decisionParams, { io: "input" })),
        async (raw) => {
          const input = raw as Record<string, unknown> & { steps?: unknown[] };
          const retrySettle = !!getDecisionPlanId() && !input.steps?.length;
          const response = await decisionSubmit(
            { ...input, steps: retrySettle ? [] : (input.steps ?? []) },
            false,
            retrySettle ? getDecisionPlanId() : undefined,
          );
          if (response.plan?.committed) setDecisionPlanId(response.plan_id);
          if (response.settle?.ok && !response.settle.more) setDecisionsCommitted(true);
          diagnose("decision_submission", {
            plan_id: response.plan_id,
            reused: response.plan?.reused ?? null,
            steps: response.plan?.steps ?? [],
            warnings: response.plan?.warnings ?? [],
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
  if (job.kind === "execute" || job.kind === "peer")
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
        "Persist an observed fact immediately. conclusion (≤120 characters) is what the fact asserts and is always shown in full; status separates positive, negative and disputed results. A not_observed fact also records request {method,url}, parameter_sources [{parameter,source,evidence_ids}] and negative_scope {attempted,not_tested,confidence} so Review can distinguish a bounded absence from a wrong-parameter or exhausted claim; observed facts omit request and parameter_sources.",
        // The same schema the store enforces. Rejecting here names the offending
        // field before upload, instead of a 422 after the observation was written
        // in the model's context.
        Type.Unsafe(z.toJSONSchema(factInputSchema, { io: "input" })),
        async (args) => {
          const parsed = factInputSchema.safeParse(args);
          if (!parsed.success)
            throw new Error(
              `Invalid fact submission: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "fact"}: ${i.message}`)
                .join("; ")}`,
            );
          const fact = await submit<Fact>(
            job.kind === "peer" ? `${peerBase}/facts` : `/fgs/steps/${job.step_id}/facts`,
            { worker: job.worker, ...parsed.data },
          );
          submittedFacts.push({ id: fact.id, description: parsed.data.description });
          return fact;
        },
      ),
      tool(
        "submit_finding",
        "Submit or revise a candidate finding with evidence. traffic_ids references captured HTTP(S) flow ids and is optional.",
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
          return submit(job.kind === "peer" ? `${peerBase}/findings` : `/fgs/steps/${job.step_id}/findings`, {
            worker: job.worker,
            ...parsed.data,
          });
        },
      ),
      tool(
        "discover_assets",
        "Record discovered hosts as pending assets. Submit any host you judge relevant to the target; each becomes a pending asset carrying your source and evidence. A human must approve it before any planning or request, so state why it belongs to the target. This call never approves or tests hosts.",
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
          submit(job.kind === "peer" ? `${peerBase}/assets` : "/assets", {
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
        "Save a project workspace file as immutable Evidence and return its id.",
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
            {
              title: a.title,
              step_id: job.kind === "peer" ? undefined : job.step_id,
              mime_type: a.mime_type || "text/plain",
            },
            (body) => submit<Evidence>("/evidence", body),
          );
          return e;
        },
      ),
      tool(
        "query_traffic",
        "List the HTTP(S) flows the recording proxy captured for this Step (or this peer turn in swarm mode), newest first, with flow ids and summaries. Cite the exact flow ids in submit_finding.traffic_ids.",
        Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
        async (a) => {
          const query = new URLSearchParams();
          if (job.run_id) query.set("run_id", job.run_id);
          if (a.limit) query.set("limit", String(a.limit));
          if (job.kind === "peer") return client.request(p(`${peerBase}/traffic?${query.toString()}`));
          return client.request(
            p(`/fgs/steps/${encodeURIComponent(job.step_id || "unknown")}/traffic?${query.toString()}`),
          );
        },
      ),
    );
  if (job.kind === "peer")
    tools.push(
      tool(
        "send_message",
        "给同伴发消息。省略 to 即广播。handoff 必须在 refs 包含已有 Fact 或 Evidence ID；说明已知缺口。没有已有观测时使用 question 或 notice。",
        Type.Object({
          to: Type.Optional(Type.String()),
          kind: Type.Optional(Type.String()),
          body: Type.String(),
          refs: Type.Optional(Type.Array(Type.String())),
        }),
        (a) =>
          submit(`${peerBase}/messages`, {
            worker: job.worker,
            ...(a.to ? { to: a.to } : {}),
            kind: a.kind ?? "share",
            body: a.body,
            refs: a.refs ?? [],
          }),
      ),
      tool(
        "read_inbox",
        "读取发给你的消息（含广播），按 seq 增量。",
        Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) }),
        (a) => client.request(p(`${peerBase}/inbox${a.after != null ? `?after=${a.after}` : ""}`)),
      ),
      tool("list_peers", "列出当前所有执行者的身份、状态、方向与回合数。", Type.Object({}), async () => {
        const swarm = await client.request<{ peers: unknown[] }>(p("/swarm"));
        return swarm.peers;
      }),
      tool(
        "spawn_peer",
        "裂变一个新的平等执行者去并行探索一个方向。start_message 是交接时须提供 start_refs（已有 Fact 或 Evidence ID）；没有观测可省略交接并用 question 交流。parent 只是血缘，不产生指挥权。",
        Type.Object({
          reason: Type.String(),
          direction: Type.Optional(Type.String()),
          start_message: Type.Optional(Type.String()),
          start_refs: Type.Optional(Type.Array(Type.String())),
        }),
        (a) => submit(`${peerBase}/spawn`, { worker: job.worker, ...a }),
      ),
      tool(
        "retire_peer",
        "退出。理由必填；退出不等于完成，遗留活动仍可能阻塞共识。",
        Type.Object({ reason: Type.String() }),
        (a) => submit(`${peerBase}/retire`, { worker: job.worker, ...a }),
      ),
      tool(
        "propose_completion",
        "发起完成共识：提交覆盖表（覆盖全部已观测 host+path，tested 带 evidence、waived 带理由、na 表示不适用）；当前未处置的 Review 问题必须逐条处置——addressed 引用审核之后保存的新证据，waived 说明理由（高风险问题只能由操作员在审核页豁免）。全体活跃执行者同意、且没有人还有未读消息和未结束回合后，才进入审核收尾。",
        Type.Object({
          reason: Type.Optional(Type.String()),
          coverage: Type.Optional(Type.Array(Type.Any())),
          review_issues: Type.Optional(Type.Array(Type.Any())),
        }),
        (a) =>
          submit(`${peerBase}/completion/propose`, {
            worker: job.worker,
            reason: a.reason,
            coverage: a.coverage ?? [],
            review_issues: a.review_issues ?? [],
          }),
      ),
      tool(
        "respond_completion",
        "对当前开放共识轮次表态：agree / disagree / unsure。沉默不等于同意。",
        Type.Object({
          round_id: Type.String(),
          opinion: Type.Union([Type.Literal("agree"), Type.Literal("disagree"), Type.Literal("unsure")]),
          note: Type.Optional(Type.String()),
        }),
        (a) => submit(`${peerBase}/completion/respond`, { worker: job.worker, ...a }),
      ),
    );

  return tools;
}
