import { fail } from "./errors.js";
export { DomainError } from "./errors.js";
import { submitDecisionBatch, type DecisionContext, type DecisionResponse } from "./decisions.js";
export type { SettleConflict, DecisionPlanResult, SettleResult, DecisionResponse } from "./decisions.js";
import {
  queryGraphChanges,
  searchGraphMemory,
  recordGraphRead,
  updateCooldown,
  peekCold,
  readGraphChange,
  type HistoryContext,
} from "./history.js";
import { findingAssets, stepAssets } from "../../protocol/src/asset-scope.js";
import { pendingReviews } from "../../protocol/src/review-scheduling.js";
import { previewNodeDeletions, planNodeDeletions, applyNodeDeletions } from "./node-deletion.js";
import { activeGraph, isActiveNode } from "../../protocol/src/node-lifecycle.js";
import { reportMaterial } from "./report-material.js";
import { validateReviewResult, ReviewValidationError } from "../../protocol/src/review-validation.js";
import { effectiveStepPriority, stepCoversHint } from "./hint-coverage.js";
import { reopenLeadsForStep } from "./leads.js";
import { normalizeSurface, originHost } from "../../protocol/src/coverage.js";
import { DatabaseSync } from "node:sqlite";
import { controlPlane } from "./control-plane.js";
import { GraphStorage } from "./graph-storage.js";
import { Retention } from "./retention.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { domainToASCII } from "node:url";
import { modelIssue } from "../../protocol/src/model-errors.js";
import { classifyFailure, infrastructureBackoff, type FailureKind } from "../../protocol/src/failure.js";
import { TIMEOUT_DEFAULTS } from "../../protocol/src/timeouts.js";
import type { z } from "zod";
import type {
  Graph,
  Step,
  Fact,
  Finding,
  Evidence,
  Event,
  Job,
  Lead,
  OverviewFinding,
  ProjectSummary,
  Run,
  SecurityOverview,
} from "../../protocol/src/index.js";
import { ExecutionRecords, digest } from "./execution.js";
import { normalizeFindingIdentity } from "../../protocol/src/finding-identity.js";
import { TrafficRecords } from "./traffic.js";
import type { ChangesQuery } from "./memory-changes.js";
import { memoryKinds } from "./memory.js";
import { conclusionFrom } from "./projection.js";
import { CvssError, scoreCvss, severityFromScore, validateImpactEvidence, type CvssRecord } from "./cvss.js";
import { archiveFinding, duplicateFindingGroups, relatedFindingGroups } from "./finding-merges.js";
import { acceptInformational, informationalAwaitingReview } from "./informational-review.js";
import { findingKind, classificationReviewRequired } from "../../protocol/src/finding-policy.js";
import { planningRevision, decidedPlanningRevision, searchState } from "../../protocol/src/planning.js";
import { planningChanged } from "./planning-changes.js";
import { reviewIssueConflicts } from "./review-issues.js";
import { allOverviewFindings, confirmedInformational, confirmedVulnerability, securityOverview } from "./overview.js";
import { MemorySearch, SEARCH_SCHEMA_VERSION, type PeekPage } from "./search.js";
import { bookmarkInputSchema, MAX_CONCLUSION_LENGTH, type Bookmark } from "../../protocol/src/index.js";
import type {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  reviewSchema,
  findingActionSchema,
  evidenceSchema,
  submitDecisionsSchema,
} from "../../protocol/src/index.js";
const now = () => new Date().toISOString();
/** Bumped whenever a startup migration changes the persisted graph shape. */
const DECIDE_MAX_BATCH_WAIT_MS = 30000;
const expired = (timestamp: string | null | undefined, seconds: number) =>
  !timestamp || Date.now() - Date.parse(timestamp) > seconds * 1000;
const ready = (timestamp: string | undefined) => !timestamp || Date.parse(timestamp) <= Date.now();
const executeCapacityFailure = (error?: string) =>
  modelIssue(error)?.kind === "context" ||
  /^(?:Closeout budget exhausted|Read-only recovery closeout timeout)/i.test(error || "");
/**
 * Coldness bookkeeping is memory management, not material change: it must never
 * bump a revision, invalidate a pending completion or pollute the change index.
 */
const metadataFields = new Set(["last_referenced_round", "last_read_round", "cooldown_override"]);
const material = (value: unknown) => JSON.stringify(value, (key, item) => (metadataFields.has(key) ? undefined : item));
export function hostname(value: string): string {
  const raw = value.trim().replace(/^\*\./, "");
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return fail(422, "Invalid hostname");
  }
  host = domainToASCII(host.replace(/\.$/, "")).toLowerCase();
  if (!host || host.includes("/") || host.length > 253) return fail(422, "Invalid hostname");
  return host;
}
const collections = [
  "facts",
  "goals",
  "steps",
  "leads",
  "hints",
  "findings",
  "assets",
  "evidence",
  "reviews",
  "usage",
  "bookmarks",
] as const;
export class Store {
  readonly db: DatabaseSync;
  readonly evidenceRoot: string;
  private reasonLeaseSeconds: number;
  readonly execution: ExecutionRecords;
  readonly traffic: TrafficRecords;
  readonly search: MemorySearch;
  private readonly graphs: GraphStorage;
  readonly retention: Retention;
  private transactionDepth = 0;
  /**
   * Operator review scope. When true, explicitly informational Findings that
   * already cite evidence are accepted without starting a Review run.
   */
  skipInformationalReview = false;
  constructor(
    file: string,
    public leaseSeconds = TIMEOUT_DEFAULTS.lease_seconds,
  ) {
    this.reasonLeaseSeconds = leaseSeconds;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.evidenceRoot =
      file === ":memory:"
        ? join(process.env.TESSERA_TEST_DIR || ".tessera", "evidence")
        : join(dirname(file), "evidence");
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS platform_projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_reports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_report_project ON platform_reports(project_id);
      CREATE TABLE IF NOT EXISTS platform_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_event_project ON platform_events(project_id,seq);
      CREATE TABLE IF NOT EXISTS platform_settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_tombstones(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_submissions(
        project_id TEXT NOT NULL,submission_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        response TEXT NOT NULL,plan_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(project_id,submission_id));
      CREATE TABLE IF NOT EXISTS platform_plans(
        plan_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,submission_id TEXT NOT NULL,
        data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS platform_plan_submission ON platform_plans(project_id,submission_id);
      CREATE TABLE IF NOT EXISTS platform_pools(
        project_id TEXT PRIMARY KEY,pool_revision INTEGER NOT NULL,seed TEXT NOT NULL,
        fingerprint TEXT NOT NULL,algorithm TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT OR IGNORE INTO platform_settings VALUES(1,'${JSON.stringify({
        intent_timeout: leaseSeconds,
        reason_timeout: leaseSeconds,
      })}');`);
    this.graphs = new GraphStorage(this.db);
    this.retention = new Retention(this.db, this.evidenceRoot);
    this.execution = new ExecutionRecords(this.db);
    this.traffic = new TrafficRecords(this.db, this.evidenceRoot);
    this.search = new MemorySearch(this.db);
    this.rebuildSearch();
    this.migrateLeaseDefaults();
    const settings = this.settings();
    this.leaseSeconds = settings.intent_timeout;
    this.reasonLeaseSeconds = settings.reason_timeout;
  }
  /**
   * 120s was the hard-coded default before the heartbeat/timeout budget existed.
   * Raising it once keeps deployments that never tuned the value from reclaiming
   * Workers in the middle of a legitimately slow control-plane write. A value an
   * operator actually chose is left alone.
   */
  private migrateLeaseDefaults() {
    if (this.db.prepare("SELECT 1 FROM platform_meta WHERE key='lease_default_180'").get()) return;
    const current = this.settings();
    if (current.intent_timeout === 120 && current.reason_timeout === 120)
      this.db.prepare("UPDATE platform_settings SET data=? WHERE id=1").run(
        JSON.stringify({
          intent_timeout: TIMEOUT_DEFAULTS.lease_seconds,
          reason_timeout: TIMEOUT_DEFAULTS.lease_seconds,
        }),
      );
    this.db.prepare("INSERT INTO platform_meta(key,value) VALUES('lease_default_180',?)").run(now());
  }
  maintenance() {
    if (this.transactionDepth) return;
    const legacy = this.db
      .prepare(
        "SELECT id FROM platform_projects WHERE status!='active' AND json_extract(data,'$.format_version')=1 AND json_extract(data,'$.storage_version') IS NULL LIMIT 1",
      )
      .get();
    if (legacy) this.transaction(() => this.persist(this.get(String(legacy.id))));
    this.retention.archive();
    // Archived history, receipts and frozen evidence remain available until project deletion.
    // Reclaim deleted pages only while the runtime is idle; never prune active attempts.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if (this.db.prepare("SELECT 1 FROM platform_projects WHERE status='active' LIMIT 1").get()) return;
    const pages = Number(this.db.prepare("PRAGMA freelist_count").get()?.freelist_count || 0);
    const size = Number(this.db.prepare("PRAGMA page_size").get()?.page_size || 4096);
    if (pages * size >= 16 * 1024 * 1024) this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    // Measured from BEGIN: SQLite on a bind mount is the suspected control-plane
    // cost, so its wall time must be visible next to the HTTP request it blocks.
    const started = performance.now();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
      controlPlane.recordTransaction(performance.now() - started);
    }
  }
  submit(id: string, operation: string, key: string | undefined, payload: unknown, fn: () => unknown): unknown {
    if (!key) return fn();
    return this.transaction(() => {
      const hash = digest(payload),
        saved = this.execution.receipt(id, operation, key);
      if (saved) {
        if (saved.payload_hash !== hash) fail(409, "Submission key already used with different content");
        return JSON.parse(String(saved.response));
      }
      const before = this.get(id),
        result = fn();
      const after = result && typeof result === "object" && "project" in result ? (result as Graph) : undefined;
      // Step completion returns its graph; receipts retain a bounded acknowledgement.
      const response =
        result && typeof result === "object" && "project" in result
          ? {
              ok: true,
              project_id: id,
              revision: after!.revision,
              fact_ids: after!.facts.filter((f) => !before.facts.some((old) => old.id === f.id)).map((f) => f.id),
              findings: after!.findings
                .filter((f) => !before.findings.some((old) => old.id === f.id && old.version === f.version))
                .map((f) => ({ id: f.id, version: f.version })),
            }
          : result;
      const wireResponse = JSON.parse(JSON.stringify(response));
      this.execution.saveReceipt(id, operation, key, hash, wireResponse);
      return wireResponse;
    });
  }
  runs(id: string, limit = 200) {
    this.get(id);
    return this.execution.list(id, limit);
  }
  private claimRun(g: Graph, job: Job, claimId?: string): Job {
    const claimed = this.execution.create(job, claimId);
    if (job.kind === "decide") g.project.reason!.run_id = claimed.run_id;
    if (job.kind === "execute") g.steps.find((s) => s.id === job.step_id)!.run_id = claimed.run_id;
    if (job.kind === "review") g.findings.find((f) => f.id === job.finding_id)!.review_run_id = claimed.run_id;
    return claimed;
  }
  private rebuildSearch() {
    const projects = this.rows("SELECT id,data FROM platform_projects");
    const indexed = new Set(
      this.db
        .prepare("SELECT DISTINCT project_id FROM memory_fts")
        .all()
        .map((row) => String(row.project_id)),
    );
    if (
      this.search.version() >= SEARCH_SCHEMA_VERSION &&
      projects.every((row) => indexed.has(JSON.parse(row.data).project.id))
    )
      return;
    this.transaction(() => {
      for (const row of projects) {
        const graph = this.graphs.load(String(row.id), String(row.data));
        if (graph.format_version !== 1) continue;
        this.search.rebuild(graph.project.id, graph, this.evidenceRoot);
      }
      this.search.markVersion();
    });
  }
  private ownsJob(g: Graph, job: Job) {
    const lease =
      job.kind === "decide"
        ? g.project.reason
        : job.kind === "execute"
          ? g.steps.find((s) => s.id === job.step_id)
          : g.findings.find((f) => f.id === job.finding_id);
    const worker =
      job.kind === "review"
        ? (lease as Finding | undefined)?.review_worker
        : (lease as Step | Graph["project"]["reason"] | undefined)?.worker;
    const runId =
      job.kind === "review"
        ? (lease as Finding | undefined)?.review_run_id
        : (lease as Step | Graph["project"]["reason"] | undefined)?.run_id;
    return (
      !(lease && "deleted" in lease && lease.deleted) &&
      worker === job.worker &&
      (!job.run_id || runId === job.run_id) &&
      (job.kind !== "review" || (lease as Finding)?.version === job.finding_version)
    );
  }
  duplicateFindings(id: string) {
    const findings = this.get(id).findings;
    return [...duplicateFindingGroups(findings), ...relatedFindingGroups(findings)];
  }
  reviseFinding(
    id: string,
    findingId: string,
    changes: Partial<z.infer<typeof findingSchema>>,
    expectedVersion?: number,
  ) {
    return this.mutate(id, "finding.submitted", true, (g) => {
      const old = g.findings.find((f) => f.id === findingId && !f.deleted) || fail(404, "Finding not found or deleted");
      if (old.merged_into) fail(409, `Finding merged into ${old.merged_into}; revise the target instead`);
      if (old.withdrawn_at)
        fail(409, "Finding withdrawn; Decide can restore this ID with restore:true and revised supporting material");
      if (expectedVersion !== undefined && expectedVersion !== old.version)
        fail(409, "发现版本已更新，草稿已保留；请核对最新内容后再提交修订。");
      const updated = {
        ...changes,
        ...(changes.identity ? { identity: normalizeFindingIdentity(changes.identity) } : {}),
      };
      if (Object.entries(updated).every(([key, value]) => digest(value) === digest(old[key as keyof Finding])))
        return old;
      const finding = this.finding(
        g,
        {
          id: old.id,
          title: old.title,
          description: old.description,
          evidence: old.evidence,
          evidence_ids: old.evidence_ids,
          from: old.from,
          status: "candidate",
          asset_id: old.asset_id,
          ...updated,
        },
        old.graph_id,
      );
      return finding;
    });
  }
  /** Post-Review operator actions, including on completed projects and library entries. */
  findingAction(id: string, findingId: string, body: z.infer<typeof findingActionSchema>) {
    const event =
      body.action === "delete"
        ? "finding.deleted"
        : body.action === "return"
          ? "finding.returned"
          : body.action === "review"
            ? "finding.review_requested"
            : "finding.retest_requested";
    return this.mutate(id, event, body.action !== "review", (g) => {
      const finding = g.findings.find((f) => f.id === findingId) || fail(404, "Finding not found");
      if (finding.deleted || finding.merged_into || finding.withdrawn_at)
        fail(409, "发现已删除、合并或撤回，请刷新后操作当前发现。");
      if (finding.version !== body.expected_version) fail(409, "发现版本已更新，请刷新并核对最新内容后操作。");
      if (!g.reviews.some((review) => review.finding_id === findingId))
        fail(409, "发现经过 Review 审核后才能人工处理。");
      if (!body.reason.trim() || !body.creator.trim()) fail(422, "请填写操作说明和操作人。");
      if (body.action === "review") return this.requestReview(g, finding, body.creator, body.reason);
      const previousRetest = g.steps.find(
        (step) => step.id === finding.human_feedback?.step_id && !step.deleted && !step.discarded && !step.concluded_at,
      );
      if (previousRetest) {
        if (previousRetest.worker)
          this.endRun(
            g,
            previousRetest.worker,
            "cancelled",
            "Retest superseded by operator action",
            previousRetest.run_id,
          );
        previousRetest.worker = null;
        previousRetest.last_heartbeat_at = null;
        previousRetest.discarded = true;
        previousRetest.close_reason = body.reason;
        reopenLeadsForStep(g, previousRetest.id);
      }
      if (body.action === "delete") {
        const plan = planNodeDeletions(g, [{ id: findingId, reason: body.reason, cascade: "none" }]);
        applyNodeDeletions(
          g,
          plan,
          { by: body.creator, submission_id: `human_${randomUUID()}` },
          this.endRun.bind(this),
        );
        return finding;
      }
      // Invalidate in-flight planning and Review before recording the operator's new version.
      this.restartAfterHumanScopeEdit(g, "人工要求重新处理漏洞，旧规划作废", g.project.status === "completed");
      this.clearDecideBackoff(g);
      archiveFinding(finding, body.creator, body.reason);
      if (finding.review_worker)
        this.endRun(g, finding.review_worker, "cancelled", "Finding returned by operator", finding.review_run_id);
      const feedback: NonNullable<Finding["human_feedback"]> = {
        action: body.action,
        reason: body.reason.trim(),
        by: body.creator,
        at: now(),
        version: finding.version + 1,
      };
      Object.assign(finding, {
        version: feedback.version,
        status: "candidate",
        review_status: "needs_evidence",
        reviewed_version: feedback.version,
        severity: null,
        severity_reason: null,
        cvss: null,
        severity_before_review: undefined,
        severity_reason_before_review: undefined,
        review_worker: null,
        review_heartbeat: null,
        review_run_id: undefined,
        review_exempt: undefined,
        retry_at: undefined,
        human_feedback: feedback,
        last_referenced_round: g.project.decision_round ?? 0,
      });
      if (body.action === "retest") {
        for (const assetId of this.findingAssets(g, finding)) this.asset(g, assetId);
        const from = finding.from.filter((source) => g.facts.some((fact) => fact.id === source && !fact.deleted));
        const step = this.insertStep(
          g,
          {
            from: from.length ? from : ["origin"],
            asset_id: finding.asset_id,
            description: `重测漏洞 ${finding.id}：${finding.title}\n人工说明：${feedback.reason}\n核对原始证据和复现条件，执行定向重测，保留新的原始证据；结果提交到 Finding ${finding.id}，说明仍可复现、已修复或证据不足。`,
            priority: 1,
          },
          body.creator,
          finding.graph_id,
        );
        step.retest_finding_id = finding.id;
        feedback.step_id = step.id;
        finding.revision_step_id = step.id;
      }
      g.reviews.push({
        id: this.next(g.reviews, "r"),
        source: "human",
        kind: finding.kind,
        finding_id: finding.id,
        finding_version: finding.version,
        verdict: "needs_evidence",
        reason: feedback.reason,
        evidence_ids: [...finding.evidence_ids],
        disputed_fact_ids: [],
        created_at: feedback.at,
        worker: body.creator,
        planning_issues: [
          body.action === "return"
            ? `人工打回：${feedback.reason}。修订或补证后重新 Review。`
            : `人工重测 ${feedback.step_id}：${feedback.reason}。执行完成后重新 Review。`,
        ],
      });
      return finding;
    });
  }
  /**
   * An exempt information-class Finding skips Review by policy. An operator can
   * ask for a real verdict later; only the review state is reset and the old
   * system Review stays in the history.
   */
  private requestReview(g: Graph, finding: Finding, by: string, reason: string) {
    if (finding.review_exempt !== "informational" || finding.review_status !== "pass")
      fail(409, "只有免审的信息类发现需要重新审核。");
    const note = `操作员要求重新审核：${reason.trim()}`;
    if (finding.review_worker) this.endRun(g, finding.review_worker, "cancelled", note, finding.review_run_id);
    finding.review_exempt = undefined;
    finding.review_requested = { at: now(), by, reason: reason.trim() };
    finding.review_status = "pending";
    finding.reviewed_version = 0;
    finding.status = "candidate";
    finding.review_worker = null;
    finding.review_heartbeat = null;
    finding.review_run_id = undefined;
    finding.retry_at = undefined;
    return finding;
  }
  /** Bulk re-review of findings that skipped Review under the informational rule. */
  reviewFindings(id: string, input: { finding_ids?: string[]; all_exempt?: boolean; creator: string; reason: string }) {
    if (!input.creator.trim() || !input.reason.trim()) fail(422, "请填写操作说明和操作人。");
    const result = this.mutate(id, "finding.review_requested", false, (g) => {
      const exempt = (finding: Finding) =>
        finding.review_exempt === "informational" &&
        finding.review_status === "pass" &&
        !finding.deleted &&
        !finding.merged_into &&
        !finding.withdrawn_at;
      const selected = input.all_exempt
        ? g.findings.filter(exempt)
        : (input.finding_ids ?? [])
            .map((findingId) => g.findings.find((finding) => finding.id === findingId))
            .filter((finding): finding is Finding => !!finding && exempt(finding));
      if (!selected.length) fail(409, "没有可重新审核的免审发现。");
      if (selected.length > 50) fail(422, "一次最多重新审核 50 条发现。");
      for (const finding of selected) this.requestReview(g, finding, input.creator, input.reason);
      return { requested: selected.map((finding) => finding.id) };
    });
    // A stopped or completed project cannot claim Review work: open the same
    // review-only window the re-audit flow uses so the new queue actually runs.
    const graph = this.get(id);
    if (graph.project.status !== "active" && !graph.project.reaudit) this.startReaudit(id);
    return result;
  }
  /**
   * Operator approval settles this exact Finding version. It is independent of
   * Review: approving also takes the claim out of the pending Review queue, which
   * is the explicit human override. A revision never inherits the approval.
   */
  setFindingApproval(
    id: string,
    findingId: string,
    body: { approved: boolean; expected_version: number; creator: string; reason?: string },
  ) {
    return this.mutate(id, body.approved ? "finding.approved" : "finding.unapproved", false, (g) => {
      const finding = g.findings.find((f) => f.id === findingId) || fail(404, "Finding not found");
      if (finding.deleted || finding.merged_into || finding.withdrawn_at)
        fail(409, "发现已删除、合并或撤回，请刷新后操作当前发现。");
      if (finding.version !== body.expected_version) fail(409, "发现版本已更新，请刷新并核对最新内容后操作。");
      if (body.approved) {
        if (finding.status === "rejected" || finding.review_status === "rejected")
          fail(409, "审核已驳回的发现不能批准；如结论有误，请回到工作台补充证据后重新提交。");
        const reason = body.reason?.trim();
        finding.human_approval = {
          at: now(),
          by: body.creator,
          version: finding.version,
          ...(reason ? { reason: reason.slice(0, 2000) } : {}),
        };
      } else {
        finding.human_approval = undefined;
      }
      return finding;
    });
  }
  private checkHumanFeedback(g: Graph, finding: Finding, evidenceIds: string[]) {
    const feedback = finding.human_feedback;
    if (!feedback) return;
    if (finding.version <= feedback.version)
      fail(409, "人工打回或重测后的原版本不能直接通过，请先修订或提交重测结果。");
    if (feedback.action !== "retest") return;
    const step = g.steps.find((s) => s.id === feedback.step_id);
    if (!step) fail(409, "人工指定的重测尚未执行完成，不能通过审核。");
    const retest = step!;
    if (!retest.executed_at || retest.deleted || retest.discarded)
      fail(409, "人工指定的重测尚未执行完成，不能通过审核。");
    const fresh = new Set([
      ...g.evidence.filter((e) => e.step_id === retest.id).map((e) => e.id),
      ...g.facts.filter((f) => !f.deleted && retest.fact_ids.includes(f.id)).flatMap((f) => f.evidence_ids),
    ]);
    const previous = new Set(
      finding.edits?.find((edit) => edit.version === feedback.version - 1)?.previous.evidence_ids ?? [],
    );
    if (!evidenceIds.some((id) => fresh.has(id) && !previous.has(id)))
      fail(422, "人工重测通过审核需引用此次重测的新原始证据。");
  }
  private endRun(
    g: Graph,
    worker: string,
    status: Run["status"],
    error?: string,
    runId?: string,
    failureKind?: FailureKind,
  ) {
    const run = runId ? this.execution.get(g.project.id, runId) : this.execution.worker(g.project.id, worker);
    if (!run || run.status !== "running") return;
    if (status === "succeeded") {
      g.project.model_failures = 0;
      g.project.model_retry_at = undefined;
      (g.project.job_failures ??= {})[run.kind] = 0;
      // A successful Run means the control plane is reachable again; do not leave
      // a permanent "retrying" banner from an earlier infrastructure failure.
      g.project.infra_failures = 0;
      g.project.infra_retry_at = undefined;
    }
    // 只有真正的失败或中断才升级为“需人工检查”。因任务被关闭、被取代或被撤销而
    // 结束的运行同样可能已经放出外部动作，但它们不再是待处理项：否则 Step 已经
    // 结束、Run 却永远停在 needs_attention，任务页与运行记录会长期各说各话。
    const step = g.steps.find((s) => s.id === run.node_id);
    const open = !!step && !step.deleted && !step.concluded_at && !step.discarded;
    if (
      (status === "failed" || status === "interrupted") &&
      run.kind === "execute" &&
      (run.external_action_possible || executeCapacityFailure(error)) &&
      open
    ) {
      status = "needs_attention";
      step!.blocked_run_id = run.id;
      step!.retry_at = undefined;
      step!.summary = `Execution failed: ${error || "执行中断"}。${run.external_action_possible ? "外部动作可能已发生" : "容量或收尾预算未满足，需先调整输入或配置"}，自动重试已停止，请检查证据后确认。`;
    }
    // A stopped/cancelled run is not a failure; only failed/interrupted runs get a kind.
    const kind = status === "succeeded" || status === "cancelled" ? undefined : (failureKind ?? classifyFailure(error));
    this.execution.finish(g.project.id, worker, status, error, run.id, kind);
    if (kind) g.project.last_failure_kind = kind;
  }
  /**
   * Step 结束时给它的 blocked Run 结案：失败记录与证据都保留，但不再算“待人工处理”。
   * blocked_run_id 只用于拦住自动领取，Step 结束后留着它只会制造长期不收敛的告警。
   */
  private settleBlockedRun(g: Graph, step: Step, by: string) {
    const runId = step.blocked_run_id;
    if (!runId) return;
    step.blocked_run_id = undefined;
    const run = this.execution.get(g.project.id, runId);
    if (!run || run.status !== "needs_attention" || run.resolved_at) return;
    run.resolved_at = now();
    run.resolved_by = by;
    this.execution.save(run);
  }
  private failedJob(g: Graph, kind: Job["kind"], error: string, failureKind?: FailureKind): string {
    const classified = classifyFailure(error, failureKind);
    g.project.last_failure_kind = classified;
    g.project.last_error = error.slice(0, 1500);
    // The control plane is not the task. These failures back off and retry; they
    // must never consume the three business failures that pause a project.
    if (classified === "infrastructure") {
      g.project.infra_failures = (g.project.infra_failures ?? 0) + 1;
      const retry = infrastructureBackoff(g.project.infra_failures);
      g.project.infra_retry_at = retry;
      if (kind === "decide") g.project.decide_retry_at = retry;
      return retry;
    }
    g.project.infra_failures = 0;
    g.project.infra_retry_at = undefined;
    const failures = (g.project.job_failures ??= {});
    failures[kind] = (failures[kind] || 0) + 1;
    const retry = new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(6, failures[kind]! - 1))).toISOString();
    if (kind === "decide") g.project.decide_retry_at = retry;
    if (!modelIssue(error) && !(kind === "execute" && executeCapacityFailure(error)) && failures[kind]! >= 3) {
      for (const run of this.execution.list(g.project.id, 1000000).filter((r) => r.status === "running"))
        this.endRun(g, run.worker, "cancelled", "Project paused after repeated execution failures", run.id);
      g.project.status = "stopped";
      g.project.reason = null;
      g.project.pending_completion = undefined;
      for (const step of g.steps) step.worker = null;
      for (const finding of g.findings) {
        finding.review_worker = null;
        finding.review_heartbeat = null;
      }
    }
    return retry;
  }
  private runFor(job: Job, project = job.project_id): Run {
    if (job.project_id !== project) return fail(422, "Job project does not match request project");
    const run = job.run_id
      ? this.execution.get(job.project_id, job.run_id)
      : this.execution.worker(job.project_id, job.worker);
    if (
      !run ||
      run.worker !== job.worker ||
      run.kind !== job.kind ||
      run.graph_id !== job.graph_id ||
      (job.kind === "execute" && run.node_id !== job.step_id) ||
      (job.kind === "review" && (run.node_id !== job.finding_id || run.finding_version !== job.finding_version))
    )
      return fail(409, "Run does not belong to this job");
    return run;
  }
  runStarted(id: string, job: Job, sessionPath: string) {
    return this.transaction(() => {
      const g = this.get(id);
      this.active(g);
      const run = this.runFor(job, id);
      if (!this.ownsJob(g, job)) fail(409, "Run lease lost");
      if (run.status !== "running") fail(409, "Run is no longer running");
      if (job.kind === "execute") this.openStep(g, job.step_id!, job.worker);
      if (job.kind === "decide" && g.project.reason?.worker !== job.worker) fail(409, "Decide lease lost");
      if (job.kind === "review" && g.findings.find((f) => f.id === job.finding_id)?.review_worker !== job.worker)
        fail(409, "Review lease lost");
      if (run.session_path && run.session_path !== sessionPath) fail(409, "Run session identity changed");
      run.session_path = sessionPath;
      this.execution.save(run);
      return run;
    });
  }
  validateSubmission(
    id: string,
    runId: string,
    payload: { worker?: string; step_id?: string },
    kind?: Job["kind"],
    node?: string,
  ) {
    const run = this.execution.get(id, runId) || fail(409, "Run not found");
    if (
      run.status !== "running" ||
      (payload.worker && payload.worker !== run.worker) ||
      (payload.step_id && payload.step_id !== run.node_id) ||
      (kind && kind !== run.kind) ||
      (node && node !== run.node_id)
    )
      fail(409, "Submission does not belong to the active Run");
    if (
      !this.ownsJob(this.get(id), {
        kind: run.kind,
        worker: run.worker,
        project_id: id,
        graph_id: run.graph_id,
        run_id: run.id,
        step_id: run.kind === "execute" ? run.node_id! : undefined,
        finding_id: run.kind === "review" ? run.node_id! : undefined,
        finding_version: run.finding_version,
      })
    )
      fail(409, "Run lease lost");
    return run;
  }
  externalAction(id: string, job: Job) {
    return this.transaction(() => {
      const g = this.get(id);
      this.active(g);
      if (job.kind !== "execute") fail(409, "Only Execute may start an external action");
      this.openStep(g, job.step_id!, job.worker);
      const run = this.runFor(job, id);
      if (!this.ownsJob(g, job)) fail(409, "Run lease lost");
      if (run.status !== "running") fail(409, "Run is no longer running");
      run.external_action_possible = true;
      run.action_started_at ||= now();
      this.execution.save(run);
      return { ok: true };
    });
  }
  retryRun(id: string, runId: string) {
    return this.mutate(id, "run.retry_confirmed", true, (g) => {
      const run = this.execution.get(id, runId) || fail(404, "Run not found");
      const step = g.steps.find((s) => s.id === run.node_id) || fail(409, "Run has no retryable Step");
      if (
        run.status !== "needs_attention" ||
        step.blocked_run_id !== runId ||
        step.worker ||
        step.concluded_at ||
        step.discarded
      )
        fail(409, "Run is not the current blocked execution");
      step.blocked_run_id = undefined;
      step.retry_at = undefined;
      step.summary += "\n人工确认允许重新执行；原运行记录与证据保留。";
      // 人工已看过这次运行，失败记录保留为历史，不再计入待处理。
      if (!run.resolved_at) {
        run.resolved_at = now();
        run.resolved_by = "operator";
        this.execution.save(run);
      }
      return step;
    });
  }
  private rows(sql: string, ...params: (string | number)[]): any[] {
    return this.db.prepare(sql).all(...params);
  }
  get(id: string): Graph {
    const row = this.db.prepare("SELECT data FROM platform_projects WHERE id=?").get(id);
    if (!row) return fail(404, "Project not found");
    const graph = this.graphs.load(id, String(row.data));
    if (graph.format_version !== 1)
      fail(409, "Project data was created by an incompatible Tessera version; recreate the project");
    if (graph.node_lifecycle_version !== undefined && graph.node_lifecycle_version !== 1)
      fail(409, "Unsupported graph node lifecycle version");
    if (graph.finding_classification_version !== undefined && graph.finding_classification_version !== 1)
      fail(409, "Unsupported Finding classification version");
    return graph;
  }
  view(id: string): Graph {
    return activeGraph(this.get(id));
  }
  changeToken(): string {
    return JSON.stringify(
      this.db
        .prepare(
          "SELECT id,status,json_extract(data,'$.revision') AS revision,(SELECT COALESCE(MAX(seq),0) FROM platform_event_history WHERE project_id=p.id) AS event FROM platform_projects p ORDER BY id",
        )
        .all(),
    );
  }
  list(): ProjectSummary[] {
    return this.db
      .prepare("SELECT id,data FROM platform_projects ORDER BY rowid DESC")
      .all()
      .map((row) => this.graphs.load(String(row.id), String(row.data)))
      .filter((graph) => graph.format_version === 1)
      .map(activeGraph)
      .map((g) => {
        // Keep the same contract as the workspace overview: merged and withdrawn
        // findings stay in history but never inflate project counters.
        const findings = g.findings.filter((f) => !f.merged_into && !f.withdrawn_at);
        return {
          ...g.project,
          search_state: searchState(g),
          fact_count: g.facts.length,
          intent_count: g.steps.length,
          working_intent_count: g.steps.filter((s) => s.worker && !s.concluded_at && !s.discarded).length,
          unclaimed_intent_count: g.steps.filter((s) => !s.worker && !s.concluded_at && !s.executed_at && !s.discarded)
            .length,
          hint_count: g.hints.length,
          finding_count: findings.length,
          confirmed_finding_count: findings.filter((f) => confirmedVulnerability(f, g)).length,
          informational_finding_count: findings.filter((f) => confirmedInformational(f, g)).length,
          pending_asset_count: g.assets.filter((a) => a.approval === "pending").length,
          review_pending_count: pendingReviews(g).length,
        };
      });
  }
  /** 跨项目安全总览：一次读取全部项目，汇总风险、趋势与待处理事项。 */
  overview(): SecurityOverview {
    return securityOverview(this);
  }
  /** 跨项目发现列表：只返回列表需要的字段，不带正文。 */
  allFindings(): OverviewFinding[] {
    return allOverviewFindings(this);
  }
  private persist(g: Graph, before?: Graph) {
    this.graphs.save(g, before);
  }
  audit(id: string, kind: string, changes: Record<string, unknown>, revision = this.get(id).revision) {
    this.db
      .prepare("INSERT INTO platform_events(project_id,revision,kind,data,created_at) VALUES(?,?,?,?,?)")
      .run(id, revision, kind, JSON.stringify({ changes, semantic: false }), now());
  }
  mutate<T>(id: string, kind: string, observation: boolean, fn: (g: Graph) => T): T {
    return this.transaction(() => {
      const g = this.get(id),
        before = structuredClone(g),
        result = (() => {
          if (g.project.deletion && !["project.deletion", "usage.recorded"].includes(kind))
            fail(409, "项目正在删除，仅允许查看或重试删除");
          return fn(g);
        })();
      const beforeDeleted = new Set(
        [...before.facts, ...before.steps, ...before.findings, ...before.goals]
          .filter((node) => node.deleted)
          .map((node) => node.id),
      );
      const deleted = [...g.facts, ...g.steps, ...g.findings, ...g.goals].some(
        (node) => node.deleted && !beforeDeleted.has(node.id),
      );
      const planning = planningChanged(before, g, kind);
      if (kind) {
        g.planning_revision ??= planningRevision(before);
        g.decided_planning_revision ??= 0;
      }
      if (planning) {
        g.planning_revision = before.revision + 1;
        g.last_planning_at = now();
        // A successful Decide can consume its own explicit settlement only when
        // its observed watermark also covers every prior planning change.
        const settled =
          kind === "decide.committed" &&
          before.project.reason &&
          !g.project.reason &&
          g.decided_planning_revision === planningRevision(before);
        if (settled) {
          g.decided_planning_revision = g.planning_revision;
          if (g.project.pending_completion) g.project.pending_completion.planning_revision = g.planning_revision;
        } else g.project.pending_completion = undefined;
        g.project.decide_pending_since ??= g.last_planning_at;
        if (kind !== "fact.observed") {
          g.project.decide_trigger_at = g.last_planning_at;
          g.project.decide_trigger_revision = g.planning_revision;
        }
        if (g.decided_planning_revision === g.planning_revision) g.project.decide_pending_since = undefined;
      }
      if (g.project.status !== "active") g.project.pending_completion = undefined;
      this.finalizeCompletion(g);
      this.finishReaudit(g);
      let indexed: Record<string, unknown> | undefined;
      if (kind && material(before) !== material(g)) {
        g.revision++;
        if (observation) {
          g.observation_revision = g.revision;
          g.last_observation_at = now();
        }
        const changes: Record<string, unknown> = {};
        for (const key of collections) {
          const previous = new Map(((before[key] ?? []) as { id: string }[]).map((v) => [v.id, material(v)]));
          const changed = ((g[key] ?? []) as { id: string }[]).filter((v) => previous.get(v.id) !== material(v));
          if (changed.length) {
            changes[key] = changed;
            (indexed ??= {})[key] = changed;
          }
        }
        changes.project = g.project;
        for (const key of [
          "observation_revision",
          "decided_revision",
          "planning_revision",
          "decided_planning_revision",
          "last_planning_at",
        ] as const)
          if (g[key] !== before[key]) changes[key] = g[key];
        this.db
          .prepare("INSERT INTO platform_events(project_id,revision,kind,data,created_at) VALUES(?,?,?,?,?)")
          .run(id, g.revision, kind, JSON.stringify({ changes, semantic: observation || deleted, planning }), now());
      }
      const skipMaterialKinds = new Set([
        "",
        "jobs.state",
        "usage.recorded",
        "decide.conflicted",
        "job.failed",
        "run.retry_confirmed",
        "step.claimed",
        "step.released",
      ]);
      const reports = !skipMaterialKinds.has(kind)
        ? this.db
            .prepare(
              "SELECT id,json_extract(data,'$.source_hash') AS source_hash FROM platform_reports WHERE project_id=?",
            )
            .all(id)
        : [];
      if (reports.length) {
        const previous = digest(reportMaterial(before)),
          current = digest(reportMaterial(g));
        if (previous !== current) {
          const stale = reports.filter((r) => r.source_hash === previous);
          if (stale.length)
            this.audit(
              id,
              "report.stale",
              {
                reports: stale.map((r) => ({
                  id: r.id,
                  title: "报告快照已过期",
                  description: "发现、审核、范围或证据输入变化，请重新生成报告。",
                })),
              },
              g.revision,
            );
        }
      }
      this.persist(g, before);
      if (indexed) this.search.sync(id, indexed as Record<string, unknown[]>, this.evidenceRoot, g);
      return result;
    });
  }
  bookmark(id: string, runId: string, input: z.infer<typeof bookmarkInputSchema>): Bookmark {
    const body = bookmarkInputSchema.parse(input);
    return this.mutate(id, "bookmark.updated", false, (g) => {
      this.active(g);
      const run = this.validateSubmission(id, runId, { worker: body.worker });
      const heartbeat =
        run.kind === "decide"
          ? g.project.reason?.last_heartbeat_at
          : run.kind === "execute"
            ? g.steps.find((s) => s.id === run.node_id)?.last_heartbeat_at
            : g.findings.find((f) => f.id === run.node_id)?.review_heartbeat;
      if (expired(heartbeat, run.kind === "decide" ? this.reasonLeaseSeconds : this.leaseSeconds))
        fail(409, "Run lease expired");
      if (
        !memoryKinds
          .filter((k) => k !== "bookmarks")
          .some((k) => (activeGraph(g)[k] ?? []).some((record) => record.id === body.node_id))
      )
        fail(422, "Bookmark requires an existing project node in the active work graph");
      const bookmarks = (g.bookmarks ??= []);
      const old = bookmarks.find((b) => b.node_id === body.node_id);
      if ((old?.version ?? 0) !== body.expected_version)
        fail(409, "Bookmark changed; read current version before updating");
      if (body.withdraw && !old) return fail(404, "Bookmark not found");
      const time = now();
      const bookmark: Bookmark = {
        id: old?.id ?? `bookmark_${randomUUID()}`,
        node_id: body.node_id,
        reason: body.reason ?? old!.reason,
        revisit_when: body.revisit_when ?? old!.revisit_when,
        version: (old?.version ?? 0) + 1,
        created_at: old?.created_at ?? time,
        updated_at: time,
        updated_by: run.worker,
        run_id: run.id,
        ...(body.withdraw ? { withdrawn_at: time } : {}),
      };
      if (old) Object.assign(old, bookmark, { withdrawn_at: bookmark.withdrawn_at });
      else bookmarks.push(bookmark);
      return bookmark;
    });
  }
  create(input: z.infer<typeof createProjectSchema>, volumePrefix?: string): Graph {
    const id = `proj_${randomUUID().slice(0, 8)}`,
      time = now();
    let seed = "";
    try {
      seed = hostname(input.origin);
    } catch {}
    const graph: Graph = {
      format_version: 1,
      finding_classification_version: 1,
      project: {
        id,
        title: input.title,
        status: "active",
        created_at: time,
        reason: null,
        decision_round: 0,
        pool_revision: 0,
        // New projects start from the measured entry budget; existing projects
        // keep whatever they stored (absent means the legacy 200-node default).
        hot_limit: 80,
        hot_char_limit: 64_000,
        ...(volumePrefix ? { volume_prefix: volumePrefix } : {}),
      },
      revision: 1,
      observation_revision: 1,
      decided_revision: 0,
      planning_revision: 1,
      decided_planning_revision: 0,
      last_planning_at: time,
      last_observation_at: time,
      facts: [
        {
          id: "origin",
          created_at: time,
          description: input.origin,
          conclusion: `目标资产：${input.origin}`.slice(0, MAX_CONCLUSION_LENGTH),
          status: "observed",
          graph_id: "main",
          evidence_ids: [],
          ...(seed ? { asset_id: "a001" } : {}),
        },
      ],
      goals: [
        {
          id: "goal",
          description: input.goal,
          state: "active",
          graph_id: "main",
        },
      ],
      steps: [],
      hints: input.hints.map((h, i) => ({
        id: `h${String(i + 1).padStart(3, "0")}`,
        ...h,
        created_at: time,
      })),
      findings: [],
      assets: seed
        ? [
            {
              id: "a001",
              hostname: seed,
              source: "seed",
              approval: "approved",
              seed: true,
              evidence_ids: [],
              created_at: time,
              approved_at: time,
              graph_id: "main",
            },
          ]
        : [],
      evidence: [],
      reviews: [],
      usage: [],
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.persist(graph);
      this.db
        .prepare("INSERT INTO platform_events(project_id,revision,kind,data,created_at) VALUES(?,?,?,?,?)")
        .run(id, 1, "project.created", JSON.stringify({ snapshot: graph, semantic: true }), time);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.search.rebuild(graph.project.id, graph, this.evidenceRoot, false);
    return graph;
  }
  private active(g: Graph) {
    if (g.project.status !== "active") fail(409, `Project is ${g.project.status}`);
  }
  private finalizeCompletion(g: Graph) {
    const pending = g.project.pending_completion;
    if (
      !pending ||
      g.project.status !== "active" ||
      g.project.reason ||
      pending.planning_revision !== planningRevision(g) ||
      decidedPlanningRevision(g) !== planningRevision(g) ||
      g.steps.some((s) => !s.deleted && !s.concluded_at && !s.discarded) ||
      g.findings.some(
        (f) =>
          !f.deleted &&
          !f.merged_into &&
          !f.withdrawn_at &&
          (f.review_worker ||
            (f.review_status === "pending" && f.version > f.reviewed_version) ||
            classificationReviewRequired(f, g)),
      )
    )
      return;
    // Completion proposals made before the Review-issue contract carry no
    // accounting field and keep their legacy behavior. New proposals always do.
    if (pending.review_issues !== undefined && reviewIssueConflicts(g, pending.review_issues).length) return;
    // Pass only the Step-shaped fields: the proposal also carries worker/run
    // bookkeeping that must not leak into the synthetic Step record.
    const step = this.insertStep(
      g,
      { from: pending.from, description: pending.description },
      pending.worker,
      pending.graph_id,
      true,
    );
    step.to = "goal";
    step.concluded_at = now();
    step.summary = pending.description;
    // `pending_completion` is cleared below; copy the accepted accounting onto
    // the completion Step so the coverage table stays on the graph afterwards.
    step.completion = {
      coverage: pending.coverage ?? [],
      ...(pending.review_issues !== undefined ? { review_issues: pending.review_issues } : {}),
      observation_revision: pending.observation_revision,
      ...(pending.planning_revision !== undefined ? { planning_revision: pending.planning_revision } : {}),
    };
    g.project.pending_completion = undefined;
    g.project.status = "completed";
    g.goals.find((v) => v.id === "goal")!.state = "satisfied";
  }
  /**
   * A re-audit is a bounded Review-only pass. Once the last finding leaves the
   * queue, put the project back where the operator found it; nothing was
   * planned or executed, so the previous lifecycle and goal state still hold.
   */
  private finishReaudit(g: Graph) {
    const reaudit = g.project.reaudit;
    if (!reaudit) return;
    if (g.findings.some((f) => f.review_worker) || pendingReviews(g).length) return;
    // A re-audit that produced new planning input must not silently complete the
    // project again: leave it active so Decide can process the review issues.
    if (reaudit.restore_status === "completed" && planningRevision(g) > reaudit.planning_revision) {
      g.project.reaudit = undefined;
      const goal = g.goals.find((v) => v.id === "goal");
      if (goal) goal.state = "active";
      return;
    }
    g.project.reaudit = undefined;
    g.project.status = reaudit.restore_status;
    if (reaudit.restore_status === "completed") {
      const goal = g.goals.find((v) => v.id === "goal");
      if (goal) goal.state = "satisfied";
    }
  }
  private next(items: { id: string }[], prefix: string) {
    let highest = 0;
    for (const item of items) highest = Math.max(highest, Number(item.id.slice(prefix.length)) || 0);
    return prefix + String(highest + 1).padStart(3, "0");
  }
  private sources(g: Graph, ids: string[], historical = false) {
    for (const id of ids) {
      if (id !== "goal" && g.facts.some((f) => f.id === id && (historical || !f.deleted))) continue;
      fail(422, `Invalid source fact ${id}${this.sourceHint(g, id)}`);
    }
  }
  /** A reference warms a node for the cooldown clock; query lists never do. */
  private markReferenced(g: Graph, ids: string[]) {
    const round = g.project.decision_round ?? 0;
    for (const id of new Set(ids)) {
      const node =
        g.facts.find((value) => value.id === id) ??
        g.findings.find((value) => value.id === id) ??
        g.evidence.find((value) => value.id === id) ??
        g.steps.find((value) => value.id === id);
      if (node) node.last_referenced_round = round;
    }
  }
  /* 说明编号用错在哪：模型常把证据编号（e###）当成事实编号，
     这里给出正确编号，让这条错误在下一轮 Decide 的视图里可自我纠正。 */
  sourceHint(g: Graph, id: string) {
    if ([...g.facts, ...g.steps, ...g.findings, ...g.goals].some((node) => node.id === id && node.deleted))
      return "（节点已删除，不能作为新计划依据；原文请用 read_graph history=true 显式读取）";
    if (g.evidence.some((e) => e.id === id)) {
      const owners = g.facts.filter((f) => !f.deleted && f.evidence_ids.includes(id)).map((f) => f.id);
      return owners.length
        ? `（${id} 是证据编号 e###，来源只能引用事实编号 f###；引用该证据的事实是 ${owners.slice(0, 3).join("、")}）`
        : `（${id} 是证据编号 e###，来源只能引用事实编号 f###；请先让事实引用它，或改用已有事实编号）`;
    }
    if (id === "goal") return "（根目标不能作为来源事实；来源应是支撑它的事实编号）";
    if (g.steps.some((s) => s.id === id)) return `（${id} 是 Step 编号 s###，来源只能引用事实编号 f###）`;
    if (g.findings.some((f) => f.id === id))
      return `（${id} 是 Finding 编号 v###，complete.from 只接受事实编号 f###；修改或撤回发现请用 finding_updates）`;
    if (g.goals.some((x) => x.id === id)) return `（${id} 是子目标编号 g###，来源只能引用事实编号 f###）`;
    return "（不存在该事实；事实编号形如 origin、f001）";
  }
  private evidenceIds(g: Graph, ids: string[]) {
    for (const id of ids)
      if (!g.evidence.some((e) => e.id === id))
        fail(
          422,
          g.facts.some((f) => f.id === id)
            ? `Unknown evidence ${id}（${id} 是事实编号 f###，evidence_ids 只能用证据编号 e###）`
            : `Unknown evidence ${id}（证据编号形如 e001）`,
        );
  }
  private asset(g: Graph, id?: string) {
    if (id && !g.assets.some((a) => a.id === id && a.approval === "approved"))
      fail(409, "Asset must be approved before testing");
  }
  /** Every asset a Finding claims to be about, directly or through its Step. */
  private findingAssets(g: Graph, finding: Finding) {
    return findingAssets(g, finding);
  }
  private openStep(g: Graph, id: string, worker?: string) {
    const s = g.steps.find((s) => s.id === id) || fail(404, "Step not found");
    if (s.deleted) fail(409, "Step deleted; use explicit history");
    if (s.concluded_at || s.discarded || s.executed_at) fail(409, "Step is already executed or concluded");
    if (worker && s.worker !== worker) fail(409, "Step lease does not belong to worker");
    for (const assetId of stepAssets(g, s)) this.asset(g, assetId);
    return s;
  }
  private checkStepVersion(step: Step, expected?: number) {
    if (step.deleted) fail(409, "Step deleted; cannot update or restore it");
    if (expected !== undefined && (step.version ?? 1) !== expected)
      fail(409, `Step version changed (expected ${expected}, current ${step.version ?? 1})`);
  }
  /** All three write paths share the same reopen transition and audit fields. */
  private reopen(g: Graph, step: Step, reason: string) {
    if (step.deleted) fail(409, "Step deleted; cannot reopen it");
    this.sources(g, step.from, true);
    for (const assetId of stepAssets(g, step)) this.asset(g, assetId);
    for (const finding of g.findings)
      if ((finding.step_id === step.id || finding.revision_step_id === step.id) && finding.review_worker) {
        this.endRun(g, finding.review_worker, "cancelled", "Step reopened", finding.review_run_id);
        finding.review_worker = null;
        finding.review_heartbeat = null;
      }
    step.concluded_at = null;
    step.executed_at = null;
    step.close_reason = undefined;
    step.reopen_reason = reason;
    step.discarded = false;
    step.discard_reason = undefined;
    step.worker = null;
    step.last_heartbeat_at = null;
    step.summary = "";
    step.to = null;
    step.retry_at = undefined;
    // 重开意味着这张单子重新排队，旧运行不再是“待人工检查”，但记录与证据保留。
    this.settleBlockedRun(g, step, "step.reopened");
    step.run_id = undefined;
    step.version = (step.version ?? 1) + 1;
  }
  private insertStep(
    g: Graph,
    input: {
      from: string[];
      description: string;
      property?: string;
      method_hint?: string;
      priority?: number;
      asset_id?: string;
      goal_id?: string;
      hint_ids?: string[];
      lead_ids?: string[];
    },
    creator: string,
    graphId = "main",
    archival = false,
  ): Step {
    this.sources(g, input.from);
    this.markReferenced(g, input.from);
    const hintVersions: Record<string, number> = {};
    for (const hid of input.hint_ids || []) {
      const hint =
        g.hints.find((h) => h.id === hid && !h.withdrawn_at) || fail(422, `Unknown or withdrawn Hint: ${hid}`);
      hintVersions[hid] = hint.version ?? 1;
    }
    for (const leadId of input.lead_ids ?? []) {
      const lead = (g.leads ?? []).find((value) => value.id === leadId);
      if (!lead) fail(422, `Unknown Lead: ${leadId}`);
      if (lead && lead.status === "waived") fail(422, `Lead ${leadId} is already waived`);
    }
    if (!archival) for (const assetId of stepAssets(g, input)) this.asset(g, assetId);
    if (!archival && input.asset_id) {
      // Planning work on a cooled asset is itself evidence that it became relevant again.
      const planned = g.assets.find((a) => a.id === input.asset_id);
      if (planned?.cooldown_override === "cooled") this.warmAsset(planned);
    }
    if (input.goal_id && !g.goals.some((v) => v.id === input.goal_id && !v.deleted)) fail(422, "Unknown goal");
    const duplicate = g.steps.find(
      (s) =>
        !s.deleted &&
        !s.concluded_at &&
        !s.discarded &&
        s.graph_id === graphId &&
        s.description === input.description &&
        JSON.stringify(s.from) === JSON.stringify(input.from) &&
        s.asset_id === input.asset_id &&
        s.goal_id === input.goal_id &&
        // A running/executed worker never received newly attached instructions.
        (!(s.worker || s.executed_at) ||
          (input.hint_ids ?? []).every((id) =>
            stepCoversHint(
              s,
              g.hints.find((h) => h.id === id)!,
            ),
          )),
    );
    if (duplicate && !archival) {
      if (
        input.hint_ids?.some(
          (id) =>
            !stepCoversHint(
              duplicate,
              g.hints.find((h) => h.id === id)!,
            ),
        )
      ) {
        duplicate.hint_ids = [...new Set([...(duplicate.hint_ids || []), ...input.hint_ids])];
        duplicate.hint_versions = { ...duplicate.hint_versions, ...hintVersions };
        duplicate.version = (duplicate.version ?? 1) + 1;
      }
      if (input.lead_ids?.some((id) => !duplicate.lead_ids?.includes(id))) {
        duplicate.lead_ids = [...new Set([...(duplicate.lead_ids ?? []), ...input.lead_ids])];
        duplicate.version = (duplicate.version ?? 1) + 1;
      }
      return duplicate;
    }
    const step: Step = {
      ...input,
      ...(input.hint_ids?.length ? { hint_versions: hintVersions } : {}),
      id: this.next(g.steps, "s"),
      priority: input.priority ?? 0,
      version: 1,
      to: null,
      discarded: false,
      creator,
      worker: null,
      last_heartbeat_at: null,
      created_at: now(),
      executed_at: null,
      concluded_at: null,
      fact_ids: [],
      summary: "",
      graph_id: graphId,
      attempts: 0,
    };
    g.steps.push(step);
    return step;
  }
  private insertFact(
    g: Graph,
    s: Step,
    input: {
      description: string;
      conclusion?: string;
      status?: Fact["status"];
      objects?: string[];
      request?: Fact["request"];
      parameter_sources?: Fact["parameter_sources"];
      evidence_ids?: string[];
    },
  ): Fact {
    const evidence_ids = input.evidence_ids ?? [];
    this.evidenceIds(g, evidence_ids);
    this.evidenceIds(
      g,
      (input.parameter_sources ?? []).flatMap((source) => source.evidence_ids ?? []),
    );
    const conclusion = input.conclusion?.trim() || conclusionFrom(input.description);
    this.markReferenced(g, evidence_ids);
    // The graph lease, rather than model-supplied fields or the latest worker Run,
    // identifies this observation. Manual submissions can legitimately have no Run.
    const run = s.run_id ? this.execution.get(g.project.id, s.run_id) : undefined;
    const productionRun =
      run?.status === "running" &&
      run.kind === "execute" &&
      run.worker === s.worker &&
      run.node_id === s.id &&
      run.graph_id === s.graph_id
        ? run
        : undefined;
    const f: Fact = {
      id: this.next(g.facts, "f"),
      description: input.description,
      conclusion: conclusion.slice(0, MAX_CONCLUSION_LENGTH),
      ...(input.conclusion?.trim() ? {} : { conclusion_inferred: true }),
      status: input.status ?? "observed",
      ...((input.status ?? "observed") === "not_observed" ? { negative_claim_version: 1 as const } : {}),
      ...(input.objects?.length ? { objects: input.objects } : {}),
      ...(input.request ? { request: input.request } : {}),
      ...(input.parameter_sources?.length ? { parameter_sources: input.parameter_sources } : {}),
      graph_id: s.graph_id,
      step_id: s.id,
      ...(productionRun ? { run_id: productionRun.id } : {}),
      created_at: now(),
      evidence_ids,
      asset_id: s.asset_id,
      // A fresh observation is part of the current working set; rank it from birth.
      last_referenced_round: g.project.decision_round ?? 0,
    };
    g.facts.push(f);
    s.fact_ids.push(f.id);
    return f;
  }
  /**
   * A lead is a durable next question. Duplicate open leads merge their
   * evidence instead of multiplying the completion checklist.
   */
  private insertLead(
    g: Graph,
    s: Step,
    input: { surface: string; parameter?: string; why: string; suggested_property: string; evidence_ids?: string[] },
  ): Lead {
    const evidence_ids = input.evidence_ids ?? [];
    this.evidenceIds(g, evidence_ids);
    // A relative lead belongs to the Step's approved asset, not necessarily the
    // project origin. Using the origin here attributed multi-asset work to the
    // wrong host and produced coverage surfaces the executor never touched.
    const assetHost = s.asset_id ? g.assets.find((asset) => asset.id === s.asset_id)?.hostname : undefined;
    const surface = normalizeSurface(input.surface, assetHost || originHost(g)) ?? input.surface.trim();
    if (!surface) fail(422, "Lead requires a host/path surface");
    const parameter = input.parameter?.trim() || undefined;
    const leads = (g.leads ??= []);
    const existing = leads.find(
      (lead) => lead.status === "open" && lead.surface === surface && lead.parameter === parameter,
    );
    if (existing) {
      for (const id of evidence_ids) if (!existing.evidence_ids.includes(id)) existing.evidence_ids.push(id);
      return existing;
    }
    const run = s.run_id ? this.execution.get(g.project.id, s.run_id) : undefined;
    const productionRun =
      run?.status === "running" &&
      run.kind === "execute" &&
      run.worker === s.worker &&
      run.node_id === s.id &&
      run.graph_id === s.graph_id
        ? run
        : undefined;
    const lead: Lead = {
      id: this.next(leads, "l"),
      surface,
      ...(parameter ? { parameter } : {}),
      why: input.why,
      suggested_property: input.suggested_property,
      evidence_ids,
      status: "open",
      step_id: s.id,
      ...(productionRun ? { run_id: productionRun.id } : {}),
      created_by: s.worker ?? "human",
      created_at: now(),
      last_referenced_round: g.project.decision_round ?? 0,
    };
    leads.push(lead);
    return lead;
  }
  private finding(g: Graph, input: z.infer<typeof findingSchema>, graphId: string, stepId?: string): Finding {
    if (!input.id && input.identity) {
      const deleted = g.findings.find(
        (f) =>
          f.deleted?.submission_id.startsWith("human_") &&
          f.identity &&
          digest(normalizeFindingIdentity(f.identity)) === digest(normalizeFindingIdentity(input.identity!)),
      );
      if (deleted) fail(409, `Finding ${deleted.id} was deleted by the operator; do not recreate the same conclusion`);
    }
    const withdrawn =
      !input.id &&
      input.identity &&
      g.findings.find(
        (f) =>
          !f.deleted &&
          f.withdrawn_at &&
          f.identity &&
          digest(normalizeFindingIdentity(f.identity)) === digest(normalizeFindingIdentity(input.identity!)),
      );
    if (withdrawn)
      fail(409, `Finding ${withdrawn.id} withdrawn; use restore:true on that ID with revised supporting material`);
    // Incremental submit + final Execute output may repeat the same delivery with
    // a fresh transport key. Reuse it without undoing Review's authoritative grade.
    // Changed deliveries from different Steps still go to Decide for semantic merge.
    if (!input.id && input.identity) {
      const key = digest(normalizeFindingIdentity(input.identity));
      const replay = g.findings.find(
        (f) =>
          !f.deleted &&
          !f.merged_into &&
          f.identity &&
          f.status !== "rejected" &&
          digest(normalizeFindingIdentity(f.identity)) === key &&
          ["title", "description", "evidence", "impact", "reproduction", "remediation", "asset_id", "kind"].every(
            (field) => {
              const proposed = input[field as keyof typeof input];
              return proposed === undefined || digest(proposed) === digest(f[field as keyof Finding]);
            },
          ) &&
          (input.evidence_ids ?? []).every((id) => f.evidence_ids.includes(id)) &&
          (input.from ?? []).every((id) => f.from.includes(id)),
      );
      if (replay) return replay;
    }
    const repeated =
      !input.id && stepId && input.identity
        ? g.findings.find(
            (f) =>
              !f.deleted &&
              !f.merged_into &&
              (f.step_id === stepId || f.revision_step_id === stepId) &&
              f.identity &&
              digest(normalizeFindingIdentity(f.identity)) === digest(normalizeFindingIdentity(input.identity!)),
          )
        : undefined;
    const old = input.id ? g.findings.find((f) => f.id === input.id) || fail(404, "Finding not found") : repeated;
    if (old?.deleted) fail(409, "Finding deleted; cannot update or restore it");
    if (repeated)
      input = {
        ...input,
        from: [...new Set([...repeated.from, ...(input.from ?? [])])],
        evidence_ids: [...new Set([...repeated.evidence_ids, ...(input.evidence_ids ?? [])])],
      };
    if (old?.merged_into) fail(409, `Finding merged into ${old.merged_into}; revise the target instead`);
    if (old?.withdrawn_at)
      fail(
        409,
        "Finding withdrawn; preserve observations as Facts and ask Decide to restore this ID with restore:true",
      );
    const merged = {
      ...old,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      title: input.title,
      description: input.description,
      from: input.from ?? old?.from ?? [],
      evidence_ids: input.evidence_ids ?? old?.evidence_ids ?? [],
      evidence: input.evidence ?? old?.evidence ?? "",
      status: input.status ?? "candidate",
    };
    let cvss: CvssRecord | null | undefined = null;
    if (input.cvss !== undefined) {
      if (input.cvss === null) cvss = null;
      else {
        try {
          cvss = scoreCvss(input.cvss);
        } catch (error) {
          fail(422, `Invalid CVSS vector: ${error instanceof CvssError ? error.message : "unparseable vector"}`);
        }
      }
    }
    this.sources(
      g,
      merged.from.filter((id) => !old?.from.includes(id)),
    );
    this.evidenceIds(g, merged.evidence_ids);
    this.markReferenced(g, [...merged.from, ...merged.evidence_ids]);
    const previousAssets = new Set(old ? stepAssets(g, old) : []);
    for (const assetId of stepAssets(g, merged)) if (!previousAssets.has(assetId)) this.asset(g, assetId);
    if (old?.review_worker)
      this.endRun(g, old.review_worker, "interrupted", "Finding revised during review", old.review_run_id);
    const candidate: Finding = {
      ...merged,
      kind: input.kind !== undefined ? input.kind : (old?.kind ?? null),
      severity: input.kind === "informational" || input.severity === "informational" ? null : (input.severity ?? null),
      severity_reason: input.severity_reason ?? null,
      cvss,
      ...(input.identity ? { identity: normalizeFindingIdentity(input.identity) } : {}),
      id: old?.id || this.next(g.findings, "v"),
      version: (old?.version || 0) + 1,
      reviewed_version: old?.reviewed_version || 0,
      severity_before_review: undefined,
      severity_reason_before_review: undefined,
      review_status: merged.status === "rejected" ? "rejected" : "pending",
      // A new version is never born exempt or approved; both are re-evaluated below.
      review_exempt: undefined,
      human_approval: undefined,
      created_at: old?.created_at || now(),
      graph_id: old?.graph_id || graphId,
      // A submitted/revised Finding is current work; rank it from birth.
      last_referenced_round: Math.max(old?.last_referenced_round ?? -1, g.project.decision_round ?? 0),
    };
    // Execute can propose confirmed, but only Review can make it reportable.
    if (candidate.status === "confirmed") candidate.status = "candidate";
    if (old) archiveFinding(old, "revision", "Finding claim or supporting material revised");
    if (candidate.kind === "informational") candidate.cvss = null;
    const saved = old
      ? Object.assign(old, candidate, {
          review_worker: null,
          review_heartbeat: null,
          retry_at: undefined,
        })
      : (g.findings.push(candidate), candidate);
    if (this.skipInformationalReview && informationalAwaitingReview(saved)) acceptInformational(g, saved);
    return saved;
  }

  private decisionContext(): DecisionContext {
    return {
      db: this.db,
      mutate: this.mutate.bind(this),
      active: this.active.bind(this),
      validateSubmission: this.validateSubmission.bind(this),
      insertStep: this.insertStep.bind(this),
      checkStepVersion: this.checkStepVersion.bind(this),
      applyAssetStates: this.applyAssetStates.bind(this),
      endRun: this.endRun.bind(this),
      reopen: this.reopen.bind(this),
      sources: this.sources.bind(this),
      sourceHint: this.sourceHint.bind(this),
      settleBlockedRun: this.settleBlockedRun.bind(this),
      evidenceIds: this.evidenceIds.bind(this),
      next: this.next.bind(this),
      skipInformationalReview: this.skipInformationalReview,
    };
  }
  previewDeletions(id: string, inputs: z.infer<typeof decideSchema>["delete_nodes"]) {
    return previewNodeDeletions(this.get(id), inputs);
  }
  submitDecisions(id: string, body: z.infer<typeof submitDecisionsSchema>, runId?: string): DecisionResponse {
    return submitDecisionBatch(this.decisionContext(), id, body, runId);
  }
  private historyContext(): HistoryContext {
    return {
      db: this.db,
      search: this.search,
      get: this.get.bind(this),
      persist: this.persist.bind(this),
      transaction: this.transaction.bind(this),
      mutate: this.mutate.bind(this),
    };
  }
  private stepFinding(g: Graph, step: Step, input: z.infer<typeof findingSchema>) {
    if (step.retest_finding_id && (!input.id || input.id === step.retest_finding_id)) {
      const target = g.findings.find((f) => f.id === step.retest_finding_id) || fail(404, "Retest Finding not found");
      input = {
        ...input,
        id: target.id,
        from: [...new Set([...target.from, ...step.fact_ids, ...(input.from ?? [])])],
        evidence_ids: [
          ...new Set([
            ...target.evidence_ids,
            ...(input.evidence_ids ?? []),
            ...g.facts.filter((f) => !f.deleted && step.fact_ids.includes(f.id)).flatMap((f) => f.evidence_ids),
            ...g.evidence.filter((e) => e.step_id === step.id).map((e) => e.id),
          ]),
        ],
      };
    }
    const finding = this.finding(
      g,
      {
        ...input,
        ...(!input.id && !input.from?.length
          ? { from: step.fact_ids.filter((id) => g.facts.some((f) => f.id === id && !f.deleted)) }
          : {}),
        ...(!input.id ? { asset_id: input.asset_id || step.asset_id } : {}),
      },
      step.graph_id,
      step.id,
    );
    finding.step_id ??= step.id;
    finding.revision_step_id = step.id;
    return finding;
  }
  memoryChanges(id: string, query: ChangesQuery) {
    return queryGraphChanges(this.historyContext(), id, query);
  }
  searchMemory(id: string, keyword: string, kind?: string) {
    return searchGraphMemory(this.historyContext(), id, keyword, kind);
  }
  recordRead(id: string, recordId: string) {
    return recordGraphRead(this.historyContext(), id, recordId);
  }
  setCooldown(id: string, input: { hot_limit?: number; node_id?: string; override?: "auto" | "pinned" | "cooled" }) {
    return updateCooldown(this.historyContext(), id, input);
  }
  peekCold(id: string, query: { cursor?: string; limit?: number; kind?: string }): PeekPage {
    return peekCold(this.historyContext(), id, query);
  }
  readMemoryChange(id: string, seq: number, offset = 0, limit = 4000) {
    return readGraphChange(this.historyContext(), id, seq, offset, limit);
  }

  execute(id: string, stepId: string, body: z.infer<typeof executeSchema>) {
    return this.mutate(id, "step.executed", true, (g) => {
      this.active(g);
      const s = this.openStep(g, stepId, body.worker);
      if (body.read_only && (body.facts.length || body.findings.length || body.leads.length))
        fail(422, "Read-only recovery cannot submit new observations");
      const previousFacts = s.fact_ids.length;
      if (!body.read_only)
        for (const f of body.facts) this.insertFact(g, s, typeof f === "string" ? { description: f } : f);
      if (!body.read_only)
        for (const f of body.findings) {
          this.stepFinding(g, s, f);
        }
      if (!body.read_only) for (const lead of body.leads) this.insertLead(g, s, lead);
      if (!body.read_only) s.to = s.fact_ids[previousFacts] ?? null;
      s.summary = body.summary;
      // Read-only recovery records what the operator saw without claiming the
      // question was executed; the Step stays open for a normal Decide/Execute.
      if (!body.read_only) s.executed_at = now();
      if (!body.read_only && s.retest_finding_id) {
        const target = g.findings.find((f) => f.id === s.retest_finding_id);
        if (
          target &&
          !target.deleted &&
          !target.merged_into &&
          !target.withdrawn_at &&
          target.human_feedback?.step_id === s.id &&
          target.version === target.human_feedback.version
        ) {
          this.stepFinding(g, s, { id: target.id, title: target.title, description: target.description });
        }
      }
      s.version = (s.version ?? 1) + 1;
      s.worker = null;
      this.endRun(g, body.worker, "succeeded", undefined, s.run_id);
      if (!body.read_only)
        for (const finding of g.findings.filter((f) => !f.deleted && !f.merged_into && f.step_id === s.id)) {
          if (!finding.from.length)
            finding.from = s.fact_ids.filter((id) => g.facts.some((fact) => fact.id === id && !fact.deleted));
          if (!finding.evidence_ids.length)
            finding.evidence_ids = [
              ...new Set(
                g.facts.filter((f) => !f.deleted && finding.from.includes(f.id)).flatMap((f) => f.evidence_ids),
              ),
            ];
        }
      return g;
    });
  }
  fact(
    id: string,
    stepId: string,
    body: {
      worker: string;
      description: string;
      conclusion?: string;
      status?: Fact["status"];
      objects?: string[];
      request?: Fact["request"];
      parameter_sources?: Fact["parameter_sources"];
      evidence_ids: string[];
    },
  ) {
    return this.mutate(id, "fact.observed", true, (g) => {
      this.active(g);
      const s = this.openStep(g, stepId, body.worker);
      return this.insertFact(g, s, body);
    });
  }
  submitFinding(id: string, input: z.infer<typeof findingSchema>, graphId?: string) {
    return this.mutate(id, "finding.submitted", true, (g) => {
      this.active(g);
      return this.finding(g, input, graphId || "main");
    });
  }
  submitStepFinding(id: string, stepId: string, worker: string, input: z.infer<typeof findingSchema>) {
    return this.mutate(id, "finding.submitted", true, (g) => {
      this.active(g);
      const step = this.openStep(g, stepId, worker);
      return this.stepFinding(g, step, input);
    });
  }
  updateStep(
    id: string,
    stepId: string,
    body: { priority?: number; discard?: boolean; reason?: string; description?: string; expected_version?: number },
  ) {
    return this.mutate(id, "step.updated", true, (g) => {
      this.active(g);
      const s = g.steps.find((s) => s.id === stepId) || fail(404, "Step not found");
      this.checkStepVersion(s, body.expected_version);
      if (body.description !== undefined) {
        // The description is what the next Decider reads, so a rewrite redirects planning.
        // Only open, idle steps may be rewritten: a running Step already acted on the old text,
        // and a concluded one keeps its wording as evidence. Both replacements stay in `edits`.
        const text = body.description.trim();
        if (!text) fail(422, "任务描述不能为空");
        if (s.concluded_at || s.discarded) fail(409, "已结束的任务不能改写描述；请先 reopened 或新建任务");
        if (s.worker) fail(409, "任务正在执行，结束或停止后才能改写描述");
        if (s.executed_at && text !== s.description)
          fail(409, "任务已执行，不能改写原问题；请关闭并重开后再改写，或新建任务");
        if (text !== s.description) {
          (s.edits ??= []).push({ at: now(), editor: "human", field: "description", from: s.description });
          s.description = text;
          s.version = (s.version ?? 1) + 1;
        }
      }
      if (body.priority !== undefined) {
        if (s.priority !== body.priority) s.version = (s.version ?? 1) + 1;
        s.priority = body.priority;
      }
      if (body.discard && s.concluded_at) fail(409, "Step is already concluded; cannot discard it");
      if (body.discard) {
        if (s.worker) this.endRun(g, s.worker, "cancelled", "Step discarded by operator", s.run_id);
        this.settleBlockedRun(g, s, "step.discarded");
        s.discarded = true;
        s.concluded_at = now();
        s.worker = null;
        s.version = (s.version ?? 1) + 1;
        if (body.reason) s.discard_reason = body.reason;
        reopenLeadsForStep(g, s.id);
      }
      return g;
    });
  }
  /**
   * Rewrite the root goal or a subgoal; the previous text stays in `edits`.
   * A human rewrite is allowed while the project is stopped — that is usually
   * why the operator is editing — but never on a completed project.
   */
  editGoal(id: string, goalId: string, description: string, opts: { resume?: boolean } = {}) {
    return this.mutate(id, "goal.edited", true, (g) => {
      if (g.project.status === "completed") fail(409, "项目已完成；先在项目操作里继续评估，再改写目标");
      const goal = g.goals.find((v) => v.id === goalId) || fail(404, "Goal not found");
      if (goal.deleted) fail(409, "Goal deleted; cannot update or restore it");
      const text = description.trim();
      if (!text) fail(422, "目标描述不能为空");
      if (text === goal.description && !opts.resume) return goal;
      if (text !== goal.description) {
        (goal.edits ??= []).push({ at: now(), editor: "human", field: "description", from: goal.description });
        goal.description = text;
      }
      this.restartAfterHumanScopeEdit(g, "目标已改写，旧计划作废", opts.resume === true);
      return goal;
    });
  }
  /**
   * Rewrite the origin. The origin is the human-authored scope, so the matching
   * Asset follows it: an existing asset with the same hostname is reused, a new
   * one is authorized by this edit. Unfinished Steps sourced from the old origin
   * are stopped (their inherited asset scope changed); concluded history is kept.
   */
  editOrigin(id: string, description: string, opts: { resume?: boolean } = {}) {
    return this.mutate(id, "origin.edited", true, (g) => {
      if (g.project.status === "completed") fail(409, "项目已完成；先在项目操作里继续评估，再改写起点");
      const origin = g.facts.find((f) => f.id === "origin") || fail(404, "Origin fact not found");
      const text = description.trim();
      if (!text) fail(422, "起点不能为空");
      if (text === origin.description && !opts.resume) return origin;
      if (text !== origin.description) {
        (origin.edits ??= []).push({ at: now(), editor: "human", field: "description", from: origin.description });
        origin.description = text;
        origin.conclusion = `目标资产：${text}`.slice(0, MAX_CONCLUSION_LENGTH);
      }
      let host = "";
      try {
        host = hostname(text);
      } catch {
        host = "";
      }
      if (host) {
        let asset = g.assets.find((a) => a.hostname === host);
        if (!asset) {
          asset = {
            id: this.next(g.assets, "a"),
            hostname: host,
            source: "origin",
            evidence_ids: [],
            approval: "approved",
            seed: true,
            created_at: now(),
            approved_at: now(),
          };
          g.assets.push(asset);
        }
        const previous = origin.asset_id;
        if (previous !== asset.id) {
          origin.asset_id = asset.id;
          const old = g.assets.find((a) => a.id === previous);
          // The old scope keeps its approval and history; it just leaves the entry.
          if (old?.seed) {
            old.cooldown_override = "cooled";
            old.cool_reason = "起点已改写";
          }
          for (const step of g.steps)
            if (
              !step.deleted &&
              !step.concluded_at &&
              !step.discarded &&
              step.from.includes("origin") &&
              !step.asset_id
            ) {
              if (step.worker) this.endRun(g, step.worker, "cancelled", "起点已改写", step.run_id);
              step.discarded = true;
              step.concluded_at = now();
              step.worker = null;
              step.discard_reason = "起点已改写；原任务从旧范围出发，已停止";
              step.version = (step.version ?? 1) + 1;
              reopenLeadsForStep(g, step.id);
            }
        }
      }
      this.restartAfterHumanScopeEdit(g, "起点已改写，旧计划作废", opts.resume === true);
      return origin;
    });
  }
  /**
   * A rewrite invalidates the Decider's current snapshot: cancel the running
   * Decide so Steps planned from the old wording never land. `resume` reopens a
   * stopped project; the caller is responsible for checking a model exists.
   */
  private restartAfterHumanScopeEdit(g: Graph, reason: string, resume: boolean) {
    for (const run of this.execution
      .list(g.project.id, 10000)
      .filter((r) => r.status === "running" && r.kind === "decide"))
      this.endRun(g, run.worker, "cancelled", reason, run.id);
    g.project.reason = null;
    g.project.pending_completion = undefined;
    if (resume && g.project.status !== "active") {
      g.project.status = "active";
      const goal = g.goals.find((v) => v.id === "goal");
      if (goal) goal.state = "active";
      g.project.model_retry_at = undefined;
      this.clearDecideBackoff(g);
    }
  }
  /** A human decision: close an open or executed Step with a reason and optional evidence. */
  closeStep(
    id: string,
    stepId: string,
    body: { worker: string; reason: string; evidence_ids?: string[]; expected_version?: number },
  ) {
    return this.mutate(id, "step.closed", true, (g) => {
      this.active(g);
      const step = g.steps.find((value) => value.id === stepId) || fail(404, "Step not found");
      if (step.concluded_at || step.discarded) fail(409, "Step is already concluded");
      this.checkStepVersion(step, body.expected_version);
      this.evidenceIds(g, body.evidence_ids ?? []);
      this.markReferenced(g, body.evidence_ids ?? []);
      if (step.worker) this.endRun(g, step.worker, "cancelled", "Step closed by operator", step.run_id);
      this.settleBlockedRun(g, step, "step.closed");
      step.concluded_at = now();
      step.close_reason = body.reason;
      step.worker = null;
      step.version = (step.version ?? 1) + 1;
      return step;
    });
  }
  /** Only the decider (human or model) can undo a close; reopening reruns the Step directly. */
  reopenStep(id: string, stepId: string, body: { worker: string; reason: string; expected_version?: number }) {
    return this.mutate(id, "step.reopened", false, (g) => {
      this.active(g);
      const step = g.steps.find((value) => value.id === stepId) || fail(404, "Step not found");
      if (!step.concluded_at) fail(409, "Only a concluded step can be reopened");
      this.checkStepVersion(step, body.expected_version);
      this.reopen(g, step, body.reason);
      return step;
    });
  }
  hint(id: string, content: string, creator = "human", priority = 0) {
    return this.mutate(id, "hint.added", true, (g) => {
      const h = {
        id: this.next(g.hints, "h"),
        content,
        creator,
        priority,
        created_at: now(),
      };
      g.hints.push(h);
      if (g.project.status === "completed") {
        g.project.status = "active";
        g.goals.find((goal) => goal.id === "goal")!.state = "active";
      }
      // A human directive is not background retry state: plan it on the next
      // claim even if Decide failed earlier and an executable Step is waiting.
      this.clearDecideBackoff(g);
      return h;
    });
  }
  /**
   * Operator-only closure. A model may explain why a Hint needs no Step, but it
   * cannot attest that the human directive is settled.
   */
  resolveHint(id: string, hintId: string, body: { note?: string; by?: string } = {}) {
    return this.mutate(id, "hint.resolved", true, (g) => {
      const hint = g.hints.find((h) => h.id === hintId) || fail(404, "Hint not found");
      if (hint.withdrawn_at) fail(409, "Hint already withdrawn");
      hint.resolved = {
        at: now(),
        note: body.note?.trim() || "人工确认：无需继续跟踪",
        worker: body.by?.trim() || "human",
      };
      hint.resolved_by = "operator";
      hint.reopened_at = undefined;
      // Resolving the last open Hint can make a pending completion finalizable;
      // never let an earlier Decide model failure keep that retry backed off.
      this.clearDecideBackoff(g);
      return hint;
    });
  }
  /** Undo an operator confirmation when the directive still needs tracking. */
  reopenHint(id: string, hintId: string, body: { note?: string; by?: string } = {}) {
    return this.mutate(id, "hint.reopened", true, (g) => {
      if (g.project.status === "completed") fail(409, "项目已完成；先在项目操作里继续评估，再重开提示");
      const hint = g.hints.find((h) => h.id === hintId) || fail(404, "Hint not found");
      if (hint.withdrawn_at) fail(409, "Hint already withdrawn");
      if (!hint.resolved) fail(409, "Hint is already open");
      hint.resolved = undefined;
      hint.resolved_by = undefined;
      hint.reopened_at = now();
      if (body.note?.trim())
        hint.notes = [
          ...(hint.notes ?? []),
          { at: now(), note: body.note.trim(), worker: body.by?.trim() || "human" },
        ].slice(-10);
      this.clearDecideBackoff(g);
      return hint;
    });
  }
  /**
   * Operator-only: dismiss one planning issue raised by an authoritative Review.
   * The completion gate never accepts a model waiver for an authorization or
   * personal-data issue; this record is the human decision it looks for. A
   * waiver relaxes the gate and does not advance the planning waterline.
   */
  waiveReviewIssue(id: string, reviewId: string, index: number, body: { reason: string; by?: string }) {
    return this.mutate(id, "review.issue_waived", false, (g) => {
      if (g.project.status === "completed") fail(409, "项目已完成；先继续评估，再豁免审核问题");
      if (!Number.isInteger(index) || index < 0) fail(422, "Invalid review issue index");
      if (!body.reason.trim()) fail(422, "审核问题豁免理由不能为空");
      const review = g.reviews.find((candidate) => candidate.id === reviewId) || fail(404, "Review not found");
      if (!review.planning_issues?.[index]) fail(404, "Review issue not found");
      if (review.issue_waivers?.some((waiver) => waiver.index === index)) return review;
      review.issue_waivers = [
        ...(review.issue_waivers ?? []),
        { index, reason: body.reason.trim(), by: body.by?.trim() || "human", at: now() },
      ].sort((left, right) => left.index - right.index);
      this.clearDecideBackoff(g);
      return review;
    });
  }
  /** Undo an operator waiver while the Review issue is still the current one. */
  reopenReviewIssue(id: string, reviewId: string, index: number) {
    return this.mutate(id, "review.issue_reopened", false, (g) => {
      if (g.project.status === "completed") fail(409, "项目已完成；先继续评估，再重开审核问题");
      const review = g.reviews.find((candidate) => candidate.id === reviewId) || fail(404, "Review not found");
      if (!review.planning_issues?.[index]) fail(404, "Review issue not found");
      const waivers = review.issue_waivers ?? [];
      if (!waivers.some((waiver) => waiver.index === index)) fail(409, "Review issue is not waived");
      const remaining = waivers.filter((waiver) => waiver.index !== index);
      if (remaining.length) review.issue_waivers = remaining;
      else delete review.issue_waivers;
      this.clearDecideBackoff(g);
      return review;
    });
  }
  updateHint(
    id: string,
    hintId: string,
    body: { content?: string; priority?: number; step_ids?: string[] },
    withdraw = false,
  ) {
    return this.mutate(id, withdraw ? "hint.withdrawn" : "hint.updated", true, (g) => {
      const hint = g.hints.find((h) => h.id === hintId) || fail(404, "Hint not found");
      if (hint.withdrawn_at) fail(409, "Hint already withdrawn");
      const changed = body.content !== undefined && body.content !== hint.content;
      if (changed) hint.version = (hint.version ?? 1) + 1;
      const associated = new Set(g.steps.filter((s) => s.hint_ids?.includes(hintId)).map((s) => s.id));
      if (body.step_ids) {
        for (const sid of body.step_ids) {
          if (!g.steps.some((s) => s.id === sid && !s.deleted)) fail(422, `Unknown or deleted Step: ${sid}`);
          associated.add(sid);
        }
        const wanted = new Set(body.step_ids);
        for (const step of g.steps) {
          if (step.deleted) continue;
          const previous = step.hint_ids || [];
          const next = previous.filter((id) => id !== hintId);
          if (wanted.has(step.id)) next.push(hintId);
          const versions = { ...step.hint_versions };
          delete versions[hintId];
          // Editors may resend the old selection with new wording. That must
          // not attest that historical results satisfy the rewritten directive.
          if (wanted.has(step.id))
            versions[hintId] = changed ? (step.hint_versions?.[hintId] ?? 1) : (hint.version ?? 1);
          if (
            next.length !== previous.length ||
            next.some((id, index) => id !== previous[index]) ||
            (wanted.has(step.id) && versions[hintId] !== (step.hint_versions?.[hintId] ?? 1))
          ) {
            step.hint_ids = next;
            step.hint_versions = versions;
            step.version = (step.version ?? 1) + 1;
          }
        }
      }
      if (withdraw || changed)
        for (const step of g.steps)
          if (!step.deleted && associated.has(step.id) && !step.concluded_at) {
            if (step.worker)
              this.endRun(g, step.worker, "cancelled", "Associated Hint changed or withdrawn", step.run_id);
            this.settleBlockedRun(g, step, "step.discarded");
            step.discarded = true;
            step.concluded_at = now();
            step.worker = null;
            step.version = (step.version ?? 1) + 1;
            step.discard_reason = `人工提示 ${hintId} 已${withdraw ? "撤回" : "修改"}；停止原方向，已提交事实与证据保留`;
            reopenLeadsForStep(g, step.id);
          }
      if (body.content !== undefined) hint.content = body.content;
      if (body.priority !== undefined) hint.priority = body.priority;
      // New wording or weight must be reconsidered by the Decider. Advice and
      // operator confirmation belong to the previous wording.
      if (changed || body.priority !== undefined) {
        hint.resolved = undefined;
        hint.resolved_by = undefined;
        hint.notes = undefined;
        // A human rewrite of a directive is new work, even if the project had
        // already completed. Leaving it completed would make the edit inert:
        // claim() never plans a completed project again.
        if (!withdraw && g.project.status === "completed") {
          g.project.status = "active";
          const goal = g.goals.find((value) => value.id === "goal");
          if (goal) goal.state = "active";
          g.project.model_retry_at = undefined;
        }
      }
      if (withdraw) hint.withdrawn_at = now();
      this.clearDecideBackoff(g);
      return hint;
    });
  }
  /** Hint writes are human input: they outrank an earlier Decide failure's backoff. */
  private clearDecideBackoff(g: Graph) {
    g.project.decide_retry_at = undefined;
    if (g.project.job_failures) delete g.project.job_failures.decide;
  }

  status(id: string, status: "active" | "stopped" | "completed") {
    if (status === "completed") fail(422, "Completion is decided from evidence");
    return this.mutate(id, "project.status", true, (g) => {
      // A manual lifecycle decision ends any review-only pass.
      g.project.reaudit = undefined;
      // Re-selecting the current state is a no-op, not a reason to cancel live Runs.
      if (g.project.status === status) return g.project;
      for (const run of this.execution.list(id, 10000).filter((r) => r.status === "running"))
        this.endRun(g, run.worker, "cancelled", "Project lifecycle changed", run.id);
      if (g.project.status === "completed" && status === "active")
        g.goals.find((v) => v.id === "goal")!.state = "active";
      g.project.status = status;
      g.project.reason = null;
      if (status === "active") {
        g.project.model_retry_at = undefined;
        g.project.model_failures = 0;
        g.project.job_failures = {};
        g.project.decide_retry_at = undefined;
        for (const step of g.steps) step.retry_at = undefined;
        for (const finding of g.findings) finding.retry_at = undefined;
      }
      for (const s of g.steps) if (!s.concluded_at) s.worker = null;
      for (const f of g.findings) {
        f.review_worker = null;
        f.review_heartbeat = null;
      }
      return g.project;
    });
  }
  /**
   * Operator-triggered re-audit for findings that are current version but were
   * passed under older classification/evidence rules. Completed projects cannot
   * be claimed, so this opens a Review-only window instead of asking for a new
   * Hint (which would also reopen exploration).
   */
  startReaudit(id: string) {
    return this.mutate(id, "project.reaudit", true, (g) => {
      const count = pendingReviews(g).length;
      if (!count) fail(409, "没有等待重新审核的发现");
      if (g.project.status !== "active") {
        const restore = g.project.status;
        g.project.reaudit = { started_at: now(), restore_status: restore, planning_revision: planningRevision(g) };
        g.project.status = "active";
        g.project.pending_completion = undefined;
        g.project.model_retry_at = undefined;
        g.project.model_failures = 0;
        g.project.job_failures = {};
        for (const step of g.steps) step.retry_at = undefined;
      }
      g.project.reason = null;
      for (const finding of g.findings) finding.retry_at = undefined;
      return { count, resumed: !!g.project.reaudit };
    });
  }
  /**
   * Stop an in-flight review-only pass. Reviews that already settled stay in
   * the graph; unfinished Review runs are cancelled and the project returns to
   * the lifecycle it had when the window opened. A partially reviewed pass that
   * produced new planning input stays active so Decide can process it, matching
   * the normal end-of-reaudit rule.
   */
  cancelReaudit(id: string) {
    const current = this.get(id);
    if (!current.project.reaudit) fail(409, "没有正在进行的重新审核");
    return this.mutate(id, "project.reaudit.cancelled", true, (g) => {
      const reaudit = g.project.reaudit!;
      for (const run of this.execution.list(id, 10000).filter((r) => r.status === "running"))
        this.endRun(g, run.worker, "cancelled", "重新审核已取消", run.id);
      for (const finding of g.findings) {
        finding.review_worker = null;
        finding.review_heartbeat = null;
        finding.retry_at = undefined;
      }
      for (const step of g.steps) if (!step.concluded_at) step.worker = null;
      g.project.reaudit = undefined;
      g.project.reason = null;
      if (reaudit.restore_status === "completed" && planningRevision(g) > reaudit.planning_revision) {
        g.project.status = "active";
        const goal = g.goals.find((v) => v.id === "goal");
        if (goal) goal.state = "active";
        return { cancelled: true, status: g.project.status };
      }
      g.project.status = reaudit.restore_status;
      if (reaudit.restore_status === "completed") {
        const goal = g.goals.find((v) => v.id === "goal");
        if (goal) goal.state = "satisfied";
      }
      return { cancelled: true, status: g.project.status };
    });
  }
  rename(id: string, title: string) {
    return this.mutate(id, "project.renamed", false, (g) => {
      g.project.title = title;
      return g.project;
    });
  }
  beginDeletion(id: string, volumePrefix: string) {
    return this.transaction(() => {
      const graph = this.get(id);
      const existing = graph.project.deletion;
      if (existing) return existing;
      this.status(id, "stopped");
      return this.mutate(id, "project.deletion", false, (graph) => {
        // Deployment prefixes can change across restarts. Resources were created
        // with the project's own prefix, so deletion must use that, not today's.
        graph.project.deletion = {
          id: randomUUID(),
          requested_at: now(),
          volume_prefix: graph.project.volume_prefix ?? volumePrefix,
        };
        return graph.project.deletion;
      });
    });
  }
  deletionFailed(id: string, error: string) {
    return this.mutate(id, "project.deletion", false, (graph) => {
      if (graph.project.deletion) graph.project.deletion.error = error.slice(0, 1500);
    });
  }
  remove(id: string) {
    this.get(id);
    const root = resolve(this.evidenceRoot),
      directory = resolve(root, id);
    if (dirname(directory) !== root) fail(422, "Invalid project evidence directory");
    if (existsSync(directory)) {
      const actualRoot = realpathSync(root),
        actual = realpathSync(directory);
      if (!actual.startsWith(actualRoot + sep)) fail(422, "Project evidence directory escapes storage root");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Keep the project/retry marker if evidence cleanup fails. Docker cleanup is done before this method.
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
      this.db.prepare("INSERT OR IGNORE INTO platform_tombstones VALUES(?)").run(id);
      this.db.prepare("DELETE FROM platform_events WHERE project_id=?").run(id);
      // Submission receipts, plans and peek seeds are keyed by project id; a future
      // project that reuses the id must not inherit an old replay response.
      this.db.prepare("DELETE FROM platform_submissions WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM platform_plans WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM platform_pools WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM platform_projects WHERE id=?").run(id);
      this.traffic.remove(id);
      this.search.remove(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  discover(
    id: string,
    items: { hostname: string; source: string; evidence_ids: string[] }[],
    options: { relatedOnly?: boolean; producer?: { step_id: string; worker: string } } = {},
  ) {
    return this.mutate(id, "assets.discovered", true, (g) => {
      this.active(g);
      const step = options.producer ? this.openStep(g, options.producer.step_id, options.producer.worker) : undefined;
      const observe = (
        input: Pick<Fact, "description" | "conclusion" | "evidence_ids" | "asset_id" | "objects">,
      ): Fact => {
        if (step) {
          const fact = this.insertFact(g, step, input);
          // The discovered host is the subject; it does not inherit the tested host's approval.
          fact.asset_id = input.asset_id;
          return fact;
        }
        const fact: Fact = {
          ...input,
          id: this.next(g.facts, "f"),
          status: "observed",
          graph_id: "main",
          created_at: now(),
          last_referenced_round: g.project.decision_round ?? 0,
        };
        g.facts.push(fact);
        return fact;
      };
      const result = [];
      for (const input of items) {
        const host = hostname(input.hostname);
        this.evidenceIds(g, input.evidence_ids);
        if (options.relatedOnly) {
          // Discovery scope is anchored to explicit targets, never inferred from
          // a shared suffix, a certificate, a link or a third-party integration.
          const roots = g.assets.filter((a) => a.seed || a.approval === "approved").map((a) => a.hostname);
          const related = roots.some(
            (root) =>
              host === root || (!root.includes(":") && !/^\d+\.\d+\.\d+\.\d+$/.test(root) && host.endsWith(`.${root}`)),
          );
          if (!related) {
            let fact = g.facts.find(
              (f) =>
                !f.deleted &&
                f.objects?.includes(host) &&
                f.conclusion === `范围外主机 ${host}，仅作关联线索`.slice(0, MAX_CONCLUSION_LENGTH),
            );
            if (!fact) {
              fact = observe({
                description: `范围外主机：${host}（来源 ${input.source || "discovery"}）。仅保留关联线索，不创建待批准资产，不对其发起请求；如需纳入测试，先由人工明确扩展目标范围。`,
                conclusion: `范围外主机 ${host}，仅作关联线索`.slice(0, MAX_CONCLUSION_LENGTH),
                objects: [host],
                evidence_ids: [],
              });
            }
            fact.evidence_ids = [...new Set([...fact.evidence_ids, ...input.evidence_ids])];
            continue;
          }
        }
        let a = g.assets.find((a) => a.hostname === host);
        if (!a) {
          a = {
            ...input,
            hostname: host,
            id: this.next(g.assets, "a"),
            approval: "pending" as const,
            seed: false,
            created_at: now(),
          };
          g.assets.push(a);
          // 发现本身是观测：写一条事实，决策者才能在自己的入口里看到这次发现，
          // 而不是只看到一行待批准资产。批准与否仍由人决定。
          observe({
            description: `发现未批准主机：${host}（来源 ${input.source || "discovery"}）`,
            conclusion: `发现主机 ${host}，待批准`.slice(0, MAX_CONCLUSION_LENGTH),
            asset_id: a.id,
            evidence_ids: [...input.evidence_ids],
          });
        }
        result.push(a);
      }
      return result;
    });
  }
  approve(id: string, assetIds: string[]) {
    return this.mutate(id, "assets.approved", true, (g) => {
      let changed = false;
      for (const aid of assetIds) {
        const a = g.assets.find((a) => a.id === aid) || fail(404, "Asset not found");
        if (a.approval === "approved") continue;
        changed = true;
        a.approval = "approved";
        a.approved_at = now();
        a.graph_id = "main";
        const f: Fact = {
          id: this.next(g.facts, "f"),
          created_at: now(),
          description: `已批准测试资产：${a.hostname}`,
          conclusion: `资产 ${a.hostname} 已获批准`.slice(0, MAX_CONCLUSION_LENGTH),
          status: "observed",
          graph_id: "main",
          asset_id: a.id,
          evidence_ids: a.evidence_ids,
          last_referenced_round: g.project.decision_round ?? 0,
        };
        g.facts.push(f);
        // Approval is an observation, not a plan. The next Decide sees the fact
        // and the approved asset; the scheduler must not pre-create work for it.
      }
      if (changed && g.project.status === "completed") {
        g.project.status = "active";
        g.goals.find((v) => v.id === "goal")!.state = "active";
      }
      return g;
    });
  }
  /** Decide 的资产冷处理：只改「是否进规划入口」，批准状态由人掌握，这里不碰。 */
  private applyAssetStates(
    g: Graph,
    states: { id: string; state: "auto" | "cooled"; reason?: string; revisit_when?: string }[],
  ) {
    for (const input of states) {
      const asset = g.assets.find((a) => a.id === input.id) || fail(422, `Unknown asset: ${input.id}`);
      if (input.state === "cooled") {
        asset.cooldown_override = "cooled";
        asset.cool_reason = input.reason?.slice(0, 300);
        asset.revisit_when = input.revisit_when?.slice(0, 300);
      } else this.warmAsset(asset);
    }
  }
  private warmAsset(asset: Graph["assets"][number]) {
    asset.cooldown_override = "auto";
    asset.cool_reason = undefined;
    asset.revisit_when = undefined;
  }
  /** 人工恢复关注：冷处理是可逆的操作员决定，不改变批准。 */
  setAssetInterest(id: string, assetId: string, state: "auto" | "cooled", reason?: string) {
    return this.mutate(id, "assets.interest", true, (g) => {
      const asset = g.assets.find((a) => a.id === assetId) || fail(404, "Asset not found");
      if (state === "cooled") {
        asset.cooldown_override = "cooled";
        asset.cool_reason = reason?.slice(0, 300);
      } else this.warmAsset(asset);
      return asset;
    });
  }
  revokeAssets(id: string, assetIds: string[]) {
    return this.mutate(id, "assets.revoked", true, (g) => {
      for (const assetId of assetIds) {
        const asset = g.assets.find((a) => a.id === assetId) || fail(404, "Asset not found");
        if (asset.approval !== "approved") continue;
        asset.approval = "pending";
        asset.approved_at = undefined;
        for (const step of g.steps.filter(
          (s) => !s.deleted && !s.concluded_at && !s.discarded && stepAssets(g, s).includes(assetId),
        )) {
          if (step.worker) this.endRun(g, step.worker, "cancelled", "资产批准已撤销", step.run_id);
          this.settleBlockedRun(g, step, "step.discarded");
          step.discarded = true;
          step.discard_reason = "资产批准已撤销";
          step.concluded_at = now();
          step.version = (step.version ?? 1) + 1;
          step.worker = null;
          step.last_heartbeat_at = null;
          step.retry_at = undefined;
          reopenLeadsForStep(g, step.id);
        }
        // A review already in flight for this asset must stop too; otherwise it
        // could still write a verdict after the approval was withdrawn.
        for (const finding of g.findings)
          if (finding.review_worker && this.findingAssets(g, finding).includes(assetId)) {
            this.endRun(g, finding.review_worker, "cancelled", "资产批准已撤销", finding.review_run_id);
            finding.review_worker = null;
            finding.review_heartbeat = null;
          }
      }
      return g;
    });
  }
  addEvidence(id: string, input: z.infer<typeof evidenceSchema>): Evidence {
    const bytes = Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8");
    return this.mutate(id, "evidence.saved", false, (g) => {
      this.evidenceIds(g, input.part_ids || []);
      if (input.step_id && !g.steps.some((s) => s.id === input.step_id)) fail(422, "Unknown step");
      const e: Evidence = {
        id: this.next(g.evidence, "e"),
        title: input.title,
        ...(input.part_ids?.length ? { part_ids: input.part_ids } : {}),
        source_path: input.source_path,
        mime_type: input.mime_type,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        // Binary bodies keep searchable metadata only; text bodies are indexed in full.
        indexed:
          !input.mime_type.startsWith("image/") && input.mime_type !== "application/octet-stream" && !bytes.includes(0),
        step_id: input.step_id,
        asset_id: input.asset_id,
        created_at: now(),
      };
      const dir = join(this.evidenceRoot, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, e.id), bytes);
      g.evidence.push(e);
      return e;
    });
  }
  evidenceContent(id: string, evidenceId: string) {
    const e = this.get(id).evidence.find((e) => e.id === evidenceId) || fail(404, "Evidence not found");
    const file = join(this.evidenceRoot, id, e.id);
    const bytes = existsSync(file) ? readFileSync(file) : this.retention.evidence(id, e.id);
    if (!bytes) return fail(404, "Evidence file is unavailable");
    return { metadata: e, bytes: Buffer.from(bytes) };
  }
  review(id: string, findingId: string, body: z.infer<typeof reviewSchema>) {
    return this.mutate(id, "finding.reviewed", true, (g) => {
      this.active(g);
      const f = g.findings.find((v) => v.id === findingId) || fail(404, "Finding not found");
      if (f.deleted) fail(409, "Finding deleted; cannot review it");
      if (f.merged_into) fail(409, `Finding merged into ${f.merged_into}`);
      if (f.withdrawn_at) fail(409, "Finding withdrawn by Decide");
      if (f.review_worker !== body.worker) fail(409, "Review lease required");
      if (f.version !== body.finding_version) fail(409, "Finding changed during review");
      // Revoking scope is a human decision: no verdict may be recorded for a
      // Finding whose asset is no longer approved, even in flight.
      const unapproved = this.findingAssets(g, f).filter(
        (aid) => !g.assets.some((a) => a.id === aid && a.approval === "approved"),
      );
      if (unapproved.length) fail(409, `Asset approval was revoked: ${unapproved.join(", ")}`);
      let cvss: CvssRecord | undefined;
      try {
        cvss = validateReviewResult(g, f, body);
      } catch (error) {
        fail(
          error instanceof ReviewValidationError ? error.statusCode : 422,
          error instanceof Error ? error.message : "Invalid review result",
        );
      }
      this.markReferenced(g, body.evidence_ids);
      const kind = body.kind !== undefined ? body.kind : null;
      if (body.verdict === "pass") this.checkHumanFeedback(g, f, [...f.evidence_ids, ...body.evidence_ids]);
      // With a vector present, severity is derived from the application-computed score.
      const derived = cvss ? severityFromScore(cvss.score) : undefined;
      const severity: Finding["severity"] = derived === undefined || derived === "none" ? null : derived;
      const severityReason = cvss
        ? cvss.rationale
        : body.severity !== undefined
          ? body.severity_reason
          : f.severity_reason;
      const r = {
        source: "model" as const,
        kind,
        id: this.next(g.reviews, "r"),
        finding_id: f.id,
        finding_version: f.version,
        verdict: body.verdict,
        reason: body.reason,
        evidence_ids: body.evidence_ids,
        disputed_fact_ids: body.disputed_fact_ids,
        created_at: now(),
        worker: body.worker,
        verification: body.verification,
        planning_issues: body.planning_issues,
        severity_before_review: f.severity ?? null,
        severity,
        severity_reason: severityReason,
        ...(cvss ? { cvss } : {}),
      };
      g.reviews.push(r);
      if (f.severity_before_review === undefined) {
        f.severity_before_review = f.severity ?? null;
        f.severity_reason_before_review = f.severity_reason ?? null;
      }
      f.kind = kind;
      f.cvss = cvss ?? null;
      f.severity = severity;
      f.severity_reason = severityReason;
      f.reviewed_version = f.version;
      f.review_status = body.verdict;
      f.review_exempt = undefined;
      f.status = body.verdict === "pass" ? "confirmed" : body.verdict === "rejected" ? "rejected" : "candidate";
      f.review_worker = null;
      f.review_heartbeat = null;
      f.evidence_ids = [...new Set([...f.evidence_ids, ...body.evidence_ids])];
      this.endRun(g, body.worker, "succeeded", undefined, f.review_run_id);
      for (const fid of body.disputed_fact_ids) {
        const fact = g.facts.find((v) => v.id === fid);
        if (fact) fact.status = "disputed";
      }
      return r;
    });
  }
  events(id: string, after = 0) {
    this.get(id);
    return this.rows(
      "SELECT * FROM platform_event_history WHERE project_id=? AND seq>? ORDER BY seq LIMIT 500",
      id,
      after,
    ).map((r) => ({ ...r, data: JSON.parse(r.data) })) as Event[];
  }
  settings() {
    return JSON.parse(String(this.db.prepare("SELECT data FROM platform_settings WHERE id=1").get()!.data));
  }
  setSettings(input: { intent_timeout: number; reason_timeout: number }) {
    this.db.prepare("UPDATE platform_settings SET data=? WHERE id=1").run(JSON.stringify(input));
    this.leaseSeconds = input.intent_timeout;
    this.reasonLeaseSeconds = input.reason_timeout;
    return input;
  }
  /**
   * Switching Review to vulnerability-only is retroactive: information-class
   * findings already waiting for a Review verdict must stop blocking their
   * project. In-flight Reviews are left to finish and are never rewritten.
   */
  setSkipInformationalReview(value: boolean) {
    this.skipInformationalReview = value;
    if (!value) return;
    for (const row of this.rows("SELECT id FROM platform_projects")) {
      const id = String(row.id);
      try {
        const graph = this.get(id);
        if (graph.project.deletion || !graph.findings.some((finding) => informationalAwaitingReview(finding))) continue;
        this.mutate(id, "finding.review_skipped", false, (g) => {
          for (const finding of g.findings) if (informationalAwaitingReview(finding)) acceptInformational(g, finding);
        });
      } catch {
        // A concurrent write, deletion or unreadable legacy row leaves the
        // finding queued; the next claim, submission or settings change applies
        // the same policy. Setting the platform switch itself must not fail.
      }
    }
  }
  claim(
    id: string,
    worker: string,
    debounceMs = 1500,
    limits: { max_project_workers?: number; max_project_review_workers?: number } = {},
    claimId?: string,
  ): Job | null {
    return this.mutate(id, "jobs.state", false, (g) => {
      // A paused project simply has no claimable work. Cleanup of expired leases
      // still runs, but this is not an authorization failure.
      if (g.project.reason && expired(g.project.reason.last_heartbeat_at, this.reasonLeaseSeconds)) {
        this.endRun(
          g,
          g.project.reason.worker,
          "interrupted",
          "Decide lease expired",
          g.project.reason.run_id,
          "infrastructure",
        );
        this.failedJob(g, "decide", "Decide lease expired", "infrastructure");
        g.project.reason = null;
      }
      for (const s of g.steps)
        if (s.worker && !s.concluded_at && expired(s.last_heartbeat_at, this.leaseSeconds)) {
          this.endRun(g, s.worker!, "interrupted", "Execute lease expired", s.run_id, "infrastructure");
          const retry = this.failedJob(g, "execute", "Execute lease expired", "infrastructure");
          if (!s.blocked_run_id) s.retry_at = retry;
          s.worker = null;
        }
      for (const f of g.findings)
        if (f.review_worker && expired(f.review_heartbeat, this.leaseSeconds)) {
          this.endRun(g, f.review_worker, "interrupted", "Review lease expired", f.review_run_id, "infrastructure");
          f.retry_at = this.failedJob(g, "review", "Review lease expired", "infrastructure");
          f.review_worker = null;
        }
      // Same policy as submission: an evidence-backed information class never
      // waits for a Review slot, including findings queued before the switch.
      if (this.skipInformationalReview)
        for (const f of g.findings) if (informationalAwaitingReview(f)) acceptInformational(g, f);
      if (g.project.status !== "active" || !ready(g.project.model_retry_at) || !ready(g.project.infra_retry_at))
        return null;
      if (this.execution.worker(id, worker)?.status === "running") return null;
      const projectLimit = limits.max_project_workers ?? 4;
      const reviewLimit = Math.min(projectLimit, limits.max_project_review_workers ?? 1);
      const activeCount =
        Number(!!g.project.reason) +
        g.steps.filter((s) => s.worker && !s.concluded_at && !s.discarded).length +
        g.findings.filter((f) => f.review_worker).length;
      if (activeCount >= projectLimit) return null;
      const elapsed = (time: string) => Date.now() - Date.parse(time);
      const busy =
        g.steps.some((s) => s.worker && !s.concluded_at && !s.discarded) || g.findings.some((f) => f.review_worker);
      // A re-audit window only hands out Review jobs. Its status change is not a
      // planning input, and any pending completion was cleared when it started.
      const reaudit = !!g.project.reaudit;
      const planningAt = g.last_planning_at || g.last_observation_at;
      const pendingSince = g.project.decide_pending_since || planningAt;
      const batchReady =
        (g.project.decide_trigger_revision ?? 0) > decidedPlanningRevision(g) &&
        elapsed(g.project.decide_trigger_at || planningAt) >= debounceMs;
      const changed =
        !reaudit &&
        planningRevision(g) > decidedPlanningRevision(g) &&
        ((!busy && elapsed(planningAt) >= debounceMs) ||
          batchReady ||
          elapsed(pendingSince) >= Math.max(DECIDE_MAX_BATCH_WAIT_MS, debounceMs));
      if (changed && !g.project.reason && ready(g.project.decide_retry_at)) {
        // Later observations start a fresh batch even while Decide is running.
        g.project.decide_pending_since = undefined;
        g.project.reason = {
          worker,
          started_at: now(),
          last_heartbeat_at: now(),
        };
        return this.claimRun(
          g,
          {
            kind: "decide",
            project_id: id,
            worker,
            graph_id: "main",
          },
          claimId,
        );
      }
      const s = reaudit
        ? undefined
        : g.steps
            .filter(
              (s) =>
                !s.deleted &&
                !s.concluded_at &&
                !s.discarded &&
                !s.executed_at &&
                !s.worker &&
                !s.blocked_run_id &&
                ready(s.retry_at),
            )
            .filter((s) =>
              stepAssets(g, s).every((id) => g.assets.some((a) => a.id === id && a.approval === "approved")),
            )
            .sort(
              (a, b) =>
                effectiveStepPriority(g, b) - effectiveStepPriority(g, a) ||
                a.created_at.localeCompare(b.created_at) ||
                a.id.localeCompare(b.id),
            )[0];
      const reviewing = pendingReviews(g, reviewLimit).find((row) => row.gate === "ready")?.finding;
      if (reviewing && (!s || g.project.last_work_kind === "execute")) {
        reviewing.review_worker = worker;
        reviewing.review_heartbeat = now();
        g.project.last_work_kind = "review";
        return this.claimRun(
          g,
          {
            kind: "review",
            project_id: id,
            worker,
            graph_id: reviewing.graph_id,
            finding_id: reviewing.id,
            finding_version: reviewing.version,
          },
          claimId,
        );
      }
      if (s) {
        for (const assetId of stepAssets(g, s)) this.asset(g, assetId);
        s.worker = worker;
        s.last_heartbeat_at = now();
        s.attempts++;
        g.project.last_work_kind = "execute";
        return this.claimRun(
          g,
          {
            kind: "execute",
            project_id: id,
            worker,
            graph_id: s.graph_id,
            step_id: s.id,
          },
          claimId,
        );
      }
      return null;
    });
  }
  /**
   * Idempotent cancel for a claim the dispatcher abandoned after a timeout. Only
   * the Run created by this exact (worker, claim_id) pair is interrupted; a later
   * claim by the same worker is untouched. This never counts as a job failure.
   */
  cancelClaim(id: string, worker: string, claimId: string) {
    return this.mutate(id, "jobs.claim_abandoned", false, (g) => {
      const run = this.execution
        .list(id, 1000)
        .find((candidate) => candidate.worker === worker && candidate.claim_id === claimId);
      if (!run || run.status !== "running") return { cancelled: false };
      const retry = new Date(Date.now() + 5_000).toISOString();
      this.endRun(g, worker, "interrupted", "Claim response abandoned", run.id, "infrastructure");
      if (run.kind === "decide" && g.project.reason?.run_id === run.id) {
        g.project.reason = null;
        g.project.decide_retry_at = retry;
      }
      if (run.kind === "execute") {
        const step = g.steps.find((s) => s.id === run.node_id);
        if (step && step.run_id === run.id) {
          step.worker = null;
          step.last_heartbeat_at = null;
          if (!step.blocked_run_id) step.retry_at = retry;
        }
      }
      if (run.kind === "review") {
        const finding = g.findings.find((f) => f.id === run.node_id);
        if (finding && finding.review_run_id === run.id) {
          finding.review_worker = null;
          finding.review_heartbeat = null;
          finding.retry_at = retry;
        }
      }
      return { cancelled: true, run_id: run.id };
    });
  }
  heartbeat(id: string, job: Job) {
    return this.mutate(id, "", false, (g) => {
      this.active(g);
      if (job.project_id !== id || !this.ownsJob(g, job)) fail(409, "Run lease lost");
      if (job.kind === "decide") {
        const lease = g.project.reason;
        if (!lease || lease.worker !== job.worker) return fail(409, "Decide lease lost");
        lease.last_heartbeat_at = now();
      } else if (job.kind === "execute") {
        this.openStep(g, job.step_id!, job.worker).last_heartbeat_at = now();
      } else {
        const f = g.findings.find((f) => f.id === job.finding_id) || fail(404, "Finding not found");
        if (f.review_worker !== job.worker || f.version !== job.finding_version) fail(409, "Review lease lost");
        f.review_heartbeat = now();
      }
      const run = this.runFor(job, id);
      if (run.status !== "running") fail(409, "Run is no longer running");
      run.heartbeat_at = now();
      this.execution.save(run);
      return { ok: true };
    });
  }
  release(id: string, job: Job, error?: string, conflict = false) {
    if (conflict && (job.kind !== "decide" || error))
      fail(422, "Only a Decide refresh conflict can be released without failure");
    return this.mutate(
      id,
      conflict ? "decide.conflicted" : error ? "job.failed" : "",
      !!error && job.kind === "execute",
      (g) => {
        if (job.project_id !== id) fail(422, "Job project does not match request project");
        const owned = this.ownsJob(g, job);
        if (!owned) return { ok: true };
        const failureKind = error ? classifyFailure(error) : undefined;
        this.endRun(
          g,
          job.worker,
          conflict ? "interrupted" : error ? "failed" : "cancelled",
          error,
          job.run_id,
          failureKind,
        );
        const retry = error ? this.failedJob(g, job.kind, error, failureKind) : undefined;
        if (job.kind === "decide" && g.project.reason?.worker === job.worker) {
          g.project.reason = null;
          if (conflict) g.project.decide_conflicts = (g.project.decide_conflicts ?? 0) + 1;
          if (error) g.project.decide_retry_at = retry;
        }
        if (job.kind === "execute") {
          const s = g.steps.find((s) => s.id === job.step_id);
          if (s?.worker === job.worker) {
            s.worker = null;
            if (error) {
              if (!s.blocked_run_id) s.retry_at = retry;
              if (!s.blocked_run_id)
                s.summary = `Execution failed: ${error.slice(0, 1500)}. Previously submitted observations remain available.`;
            }
          }
        }
        if (job.kind === "review") {
          const f = g.findings.find((f) => f.id === job.finding_id);
          if (f?.review_worker === job.worker) {
            f.review_worker = null;
            if (error) f.retry_at = retry;
          }
        }
        if (error) g.project.last_error = error.slice(0, 1500);
        const issue = owned && !(job.kind === "execute" && executeCapacityFailure(error)) ? modelIssue(error) : null;
        if (issue) {
          g.project.model_failures = (g.project.model_failures || 0) + 1;
          g.project.model_retry_at = new Date(
            Date.now() + Math.min(300000, 30000 * 2 ** Math.min(4, g.project.model_failures - 1)),
          ).toISOString();
        }
        if (issue && (!issue.retryable || g.project.model_failures! >= 3)) {
          for (const run of this.execution.list(id, 10000).filter((r) => r.status === "running"))
            this.endRun(g, run.worker, "cancelled", "Project paused after model failure", run.id);
          g.project.status = "stopped";
          g.project.pending_completion = undefined;
          g.project.reason = null;
          for (const step of g.steps) if (!step.concluded_at) step.worker = null;
          for (const finding of g.findings) {
            finding.review_worker = null;
            finding.review_heartbeat = null;
          }
        }
        return { ok: true };
      },
    );
  }
  usage(
    id: string,
    job: Job,
    input: number | null,
    output: number | null,
    cost: number | null,
    requestId?: string,
    stage: "started" | "completed" = "completed",
    breakdown?: { input_uncached: number | null; cache_read: number | null; cache_write: number | null },
  ) {
    return this.mutate(id, "usage.recorded", false, (g) => {
      let run: Run | undefined;
      if (requestId) {
        run = this.runFor(job, id);
        const incoming = {
          input,
          output,
          cost,
          stage,
          input_uncached: breakdown?.input_uncached ?? null,
          cache_read: breakdown?.cache_read ?? null,
          cache_write: breakdown?.cache_write ?? null,
        };
        const row = this.db
          .prepare("SELECT data FROM platform_request_usage WHERE run_id=? AND request_id=?")
          .get(run.id, requestId);
        if (row) {
          const previous = JSON.parse(String(row.data));
          if (previous.stage === "completed" || stage === "started") {
            if (
              stage === "completed" &&
              digest({ input_uncached: null, cache_read: null, cache_write: null, ...previous }) !== digest(incoming)
            )
              fail(409, "Usage request already has different completed counters");
            return g.usage.find((u) => u.run_id === run!.id && u.request_id === requestId);
          }
        } else {
          run.unknown_breakdown_request_count ??= run.request_count;
          run.request_count++;
          run.unknown_request_count = (run.unknown_request_count || 0) + 1;
          run.unknown_breakdown_request_count++;
        }
        if (stage === "completed") {
          if (input !== null) run.input = (run.input || 0) + input;
          if (output !== null) run.output = (run.output || 0) + output;
          if (cost !== null) run.cost = (run.cost || 0) + cost;
          for (const key of ["input_uncached", "cache_read", "cache_write"] as const) {
            const value = breakdown?.[key];
            if (value != null) run[key] = (run[key] ?? 0) + value;
          }
          if (breakdown && Object.values(breakdown).every((v) => v !== null))
            run.unknown_breakdown_request_count = Math.max(
              0,
              (run.unknown_breakdown_request_count ?? run.request_count) - 1,
            );
          if (input !== null && output !== null)
            run.unknown_request_count = Math.max(0, (run.unknown_request_count || 0) - 1);
        }
        this.db
          .prepare(
            "INSERT INTO platform_request_usage VALUES(?,?,?) ON CONFLICT(run_id,request_id) DO UPDATE SET data=excluded.data",
          )
          .run(run.id, requestId, JSON.stringify(incoming));
        this.execution.save(run);
      }
      const existing = requestId && g.usage.find((u) => u.run_id === run?.id && u.request_id === requestId);
      const u = {
        id: existing ? existing.id : this.next(g.usage, "u"),
        kind: job.kind,
        graph_id: job.graph_id,
        node_id: job.step_id || job.finding_id || null,
        input,
        input_uncached: breakdown?.input_uncached ?? null,
        cache_read: breakdown?.cache_read ?? null,
        cache_write: breakdown?.cache_write ?? null,
        output,
        cost,
        created_at: now(),
        ...(run && requestId ? { run_id: run.id, request_id: requestId } : {}),
      };
      if (existing) Object.assign(existing, u);
      else g.usage.push(u);
      return u;
    });
  }

  manualStep(
    id: string,
    input: {
      from: string[];
      description: string;
      priority?: number;
      creator: string;
      claim?: boolean;
      asset_id?: string;
    },
  ) {
    return this.mutate(id, "step.declared", true, (g) => {
      this.active(g);
      const s = this.insertStep(g, input, input.creator);
      if (input.claim) {
        if (s.worker && s.worker !== input.creator) fail(409, "Step is claimed by another actor");
        s.worker = input.creator;
        s.last_heartbeat_at = now();
      }
      return s;
    });
  }
  manualHeartbeat(id: string, stepId: string, worker: string) {
    return this.mutate(id, "step.claimed", false, (g) => {
      this.active(g);
      const s = this.openStep(g, stepId);
      if (s.blocked_run_id) fail(409, "Step requires inspection and explicit retry confirmation");
      if (s.worker && s.worker !== worker && !expired(s.last_heartbeat_at, this.leaseSeconds))
        fail(409, "Step is claimed by another actor");
      s.worker = worker;
      s.last_heartbeat_at = now();
      return s;
    });
  }
  manualRelease(id: string, stepId: string, worker: string) {
    return this.mutate(id, "step.released", false, (g) => {
      this.active(g);
      const s = this.openStep(g, stepId);
      if (s.worker && s.worker !== worker && !expired(s.last_heartbeat_at, this.leaseSeconds))
        fail(409, "Step is claimed by another actor");
      if (s.worker) this.endRun(g, s.worker, "cancelled", "Execution released manually", s.run_id);
      s.worker = null;
      s.last_heartbeat_at = null;
      return s;
    });
  }
  manualConclude(id: string, stepId: string, worker: string, description: string) {
    return this.mutate(id, "step.executed", true, (g) => {
      this.active(g);
      const s = this.openStep(g, stepId);
      if (s.worker && s.worker !== worker && !expired(s.last_heartbeat_at, this.leaseSeconds))
        fail(409, "Step is claimed by another actor");
      const f = this.insertFact(g, s, { description });
      if (s.worker) this.endRun(g, s.worker, "succeeded", undefined, s.run_id);
      s.to = f.id;
      s.summary = description;
      s.worker = null;
      s.executed_at ??= now();
      this.settleBlockedRun(g, s, "step.closed");
      s.concluded_at = now();
      s.version = (s.version ?? 1) + 1;
      return { fact: f, intent: s };
    });
  }
  manualComplete(id: string, from: string[], description: string, worker: string) {
    return this.mutate(id, "project.completed.manually", true, (g) => {
      this.active(g);
      this.sources(g, from);
      const s = this.insertStep(g, { from, description }, worker, "main", true);
      // 人工完成项目会打断在途执行；这些 Step 仍是开放任务，重开项目时要先确认
      // 外部动作，所以按“中断”结束，而不是当作被取消的收尾。
      for (const run of this.execution.list(id, 1000000).filter((r) => r.status === "running"))
        this.endRun(g, run.worker, "interrupted", "Project completed manually", run.id);
      s.to = "goal";
      s.concluded_at = now();
      s.summary = description;
      g.project.status = "completed";
      g.project.reason = null;
      g.goals.find((v) => v.id === "goal")!.state = "satisfied";
      for (const step of g.steps) if (!step.concluded_at) step.worker = null;
      for (const finding of g.findings) {
        finding.review_worker = null;
        finding.review_heartbeat = null;
      }
      return s;
    });
  }
}
