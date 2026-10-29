import Fastify, { LogController } from "fastify";
import staticFiles from "@fastify/static";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import { stringify } from "yaml";
import { Store, DomainError } from "../../../packages/core/src/store.js";
import { domainStats } from "../../../packages/core/src/domain-stats.js";
import { stepCosts } from "../../../packages/core/src/step-costs.js";
import { memoryEntry, readMemoryRecord } from "../../../packages/core/src/memory.js";
import {
  createProjectSchema,
  decideSchema,
  executeSchema,
  findingSchema,
  findingActionSchema,
  findingApprovalSchema,
  reviewRequestSchema,
  reviewSchema,
  assetBatchSchema,
  evidenceSchema,
  hintSchema,
  hintUpdateSchema,
  hintResolveSchema,
  reviewIssueWaiverSchema,
  bookmarkInputSchema,
  factSubmissionSchema,
  submitDecisionsSchema,
  deletionPreviewSchema,
  peerMessageSchema,
  peerSpawnSchema,
  peerRetireSchema,
  peerTurnSchema,
  completionProposeSchema,
  completionRespondSchema,
  confirmedVulnerability,
  findingKind,
  classificationReviewRequired,
  testDomainSchema,
} from "../../../packages/protocol/src/index.js";
import type { Graph, Job, Run } from "../../../packages/protocol/src/index.js";
import type { ToolUsageReport } from "../../../packages/protocol/src/tool-usage.js";
import { modelIssue, redactModelError } from "../../../packages/protocol/src/model-errors.js";
import { RuntimeConfig } from "./runtime.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import { internalToken, projectToken, validInternalToken } from "../../../packages/protocol/src/internal-auth.js";
import { readWorkspaceSecret, workspaceSignature } from "../../../packages/protocol/src/workspace-auth.js";
import { OperatorAuth, clearedCookie, cookieValue, operatorAuthFile, sessionCookie } from "./operator-auth.js";
import { Reports } from "../../../packages/core/src/reports.js";
import { bundleTempRoot, exportProjectBundle, importProjectBundle } from "../../../packages/core/src/bundle.js";
import { trafficRecordSchema, trafficStatusSchema } from "../../../packages/protocol/src/traffic.js";
import { DiagnosticRecords, diagnosticSchema, diagnosticBuild } from "../../../packages/core/src/diagnostics.js";
import { controlPlane } from "../../../packages/core/src/control-plane.js";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { registerModelRelay, pinRunModel } from "./model-relay.js";
import { workerConfig } from "../../dispatcher/src/worker-config.js";
import { requestLogging } from "./request-logging.js";
import { runMetrics } from "../../../packages/core/src/run-metrics.js";
import { Notifier, type PendingItem } from "./notifications.js";

const text = z.string().trim().min(1).max(65536);
const jobSchema = z.object({
  kind: z.enum(["decide", "execute", "review", "peer"]),
  project_id: text,
  worker: text,
  graph_id: text,
  step_id: text.optional(),
  finding_id: text.optional(),
  finding_version: z.number().int().optional(),
  run_id: text.optional(),
  peer_id: text.optional(),
});
export function buildApp(
  store: Store,
  runtime = new RuntimeConfig(".tessera/runtime.json"),
  web = resolve("dist/web"),
  workerToken = internalToken(process.env.TESSERA_TOKEN_FILE || join(dirname(store.evidenceRoot), "internal-token")),
  options: { auth?: OperatorAuth | false; cleanupProject?: (id: string, deletionId: string) => Promise<unknown> } = {},
) {
  const app = Fastify({
    logger: { level: process.env.TESSERA_LOG_LEVEL || "info" },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 24 * 1024 * 1024,
  });
  requestLogging(app, () => [workerToken, runtime.value.model.api_key, runtime.value.review_model?.api_key || ""]);
  // Project bundles are streamed ZIPs, not JSON: keep the request stream intact so
  // a multi-gigabyte import never has to sit in the Fastify body buffer.
  app.addContentTypeParser(["application/zip", "application/octet-stream"], (_request, payload, done) => {
    done(null, payload);
  });
  registerModelRelay(app, store, runtime, workerToken);
  // Review scope is a persisted platform setting; mirror it into the store so
  // submission, revision and scheduling all apply the same rule.
  store.skipInformationalReview = runtime.value.skip_informational_review === true;
  // Feishu notifications read the live runtime config on every send, so a switch
  // toggled in Settings takes effect immediately without a restart.
  const notifier = new Notifier(() => runtime.value.notifications ?? {});
  const projectTitle = (id: string) => {
    try {
      return store.get(id).project.title || id;
    } catch {
      return id;
    }
  };
  // A successful mutating request may change what needs a human. Recompute the
  // pending-work set afterwards; Notifier only sends when a new item appears, so
  // this is cheap and does not spam. Best-effort: never affects the response.
  // Items mirror the project 人工重试 page plus the operator gates: interrupted
  // Runs awaiting a manual retry decision, assets awaiting approval, project errors.
  const refreshNeedsHuman = (prime = false) => {
    if (!prime && runtime.value.notifications?.notify_needs_human !== true) return;
    try {
      const items: PendingItem[] = [];
      for (const project of store.list()) {
        const graph = store.get(project.id);
        const blockedRuns = store
          .runs(project.id, 200)
          .filter(
            (run) =>
              run.status === "needs_attention" &&
              !run.resolved_at &&
              !!run.node_id &&
              graph.steps.some((s) => s.id === run.node_id && !s.deleted && !s.concluded_at && !s.discarded),
          );
        if (blockedRuns.length)
          items.push({
            key: `${project.id}:retry`,
            kind: "retry",
            line: `${project.title}：${blockedRuns.length} 次运行待人工重试`,
            at: blockedRuns
              .map((run) => run.finished_at || run.heartbeat_at)
              .sort()
              .at(-1),
          });
        if (project.pending_asset_count > 0)
          items.push({
            key: `${project.id}:assets`,
            kind: "assets",
            line: `${project.title}：${project.pending_asset_count} 个资产等待人工批准`,
            at: graph.assets
              .filter((asset) => asset.approval === "pending")
              .map((asset) => asset.created_at)
              .sort()
              .at(-1),
          });
        if (project.last_error)
          items.push({
            key: `${project.id}:error`,
            kind: "error",
            line: `${project.title}：项目错误 — ${String(project.last_error).replace(/\s+/g, " ").slice(0, 120)}`,
          });
      }
      if (prime) notifier.primeNeedsHuman(items);
      else notifier.notifyNeedsHuman(items);
    } catch {
      // A concurrent write or unreadable project must not surface to the caller.
    }
  };
  // Establish the baseline from work that already existed before this process
  // started. Otherwise the first successful write after a restart re-announces
  // every paused project's old pending items to Feishu.
  refreshNeedsHuman(true);
  // Control-plane timing: receive to response, per route, plus the store's own
  // transaction cost. Recording is best-effort and never affects the response.
  controlPlane.startEventLoopDelay();
  app.addHook("onRequest", async (req) => {
    (req as any).controlPlaneStart = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (req, reply) => {
    const started = (req as any).controlPlaneStart as bigint | undefined;
    if (started === undefined) return;
    const route = (req as any).routeOptions?.url || (req.url || "").split("?")[0] || "/";
    controlPlane.recordRequest(route, req.method, Number(process.hrtime.bigint() - started) / 1e6, reply.statusCode);
  });
  // Any successful non-GET request may have created work that needs a human
  // (a new candidate, a discovered asset, a project error). Recompute once the
  // response is sent so the check never delays the caller.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || reply.statusCode >= 400) return;
    if (!(req.url || "").startsWith("/api/")) return;
    refreshNeedsHuman();
  });
  const reports = new Reports(store);
  const workspaceKey = readWorkspaceSecret(dirname(store.evidenceRoot));
  // 单账号登录门：默认开启。Worker/Dispatcher 用内部 token 旁路，浏览器用签名会话 Cookie。
  const auth =
    options.auth === false
      ? null
      : (options.auth ??
        new OperatorAuth(operatorAuthFile(store.evidenceRoot), {
          user: process.env.TESSERA_OPERATOR_USER,
          password: process.env.TESSERA_OPERATOR_PASSWORD,
        }));
  const diagnostics = new DiagnosticRecords(store.db);
  const deleting = new Map<string, Promise<void>>();
  // Two-phase export: POST builds the archive and answers with a one-shot URL,
  // GET streams that file. The page therefore never navigates to a request that
  // is still building the archive — a slow or failed export stays inside the UI.
  const preparedBundles = new Map<
    string,
    { file: string; project: string; created_at: number; warnings: number; missing: number }
  >();
  const preparedTtl = 2 * 60 * 60 * 1000;
  const sweepPrepared = () => {
    const now = Date.now();
    for (const [id, entry] of preparedBundles) {
      if (now - entry.created_at < preparedTtl) continue;
      preparedBundles.delete(id);
      rmSync(entry.file, { force: true });
    }
  };
  const operatorCheck = (req: { headers: { cookie?: string } }) => {
    if (auth && !auth.valid(cookieValue(req.headers.cookie)))
      throw new DomainError(403, "该操作仅允许已登录的网页操作员执行");
  };
  // HTTPS deployments should mark the session cookie Secure; plain-HTTP local
  // installs would never receive it back, so this is opt-in or protocol-derived.
  const cookieSecure = (req: any) =>
    process.env.TESSERA_COOKIE_SECURE === "1" ||
    req.protocol === "https" ||
    /^https$/i.test(
      String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim(),
    );
  app.setErrorHandler((error, _req, reply) => {
    const status =
      error instanceof ZodError
        ? 422
        : error instanceof DomainError
          ? error.statusCode
          : (error as any).statusCode || 500;
    reply.code(status).send({
      detail: status >= 500 ? "Internal server error" : error instanceof Error ? error.message : "Request failed",
    });
  });
  // The dispatcher holds the global token. Worker containers only receive a token
  // derived for their own project, so a model in project A cannot use it for B.
  const workerCheck = (req: any, projectId?: string) => {
    if (validInternalToken(workerToken, req.headers["x-tessera-worker-token"])) return;
    if (projectId && validInternalToken(projectToken(workerToken, projectId), req.headers["x-tessera-project-token"]))
      return;
    throw new DomainError(403, "Worker token required");
  };
  const projectReadCheck = (req: any, projectId: string) => {
    if (auth?.valid(cookieValue(req.headers.cookie))) return;
    workerCheck(req, projectId);
  };
  // List/config calls are dispatcher-only; a project token must not enumerate other projects.
  const dispatcherCheck = (req: any) => {
    if (!auth) return;
    if (auth.valid(cookieValue(req.headers.cookie))) return;
    if (validInternalToken(workerToken, req.headers["x-tessera-worker-token"])) return;
    throw new DomainError(403, "Operator or dispatcher credential required");
  };
  const commit = (
    req: any,
    operation: string,
    schema: z.ZodType,
    fn: (body: any, run?: Run) => unknown,
    kind?: Job["kind"],
    node?: string,
  ) => {
    const { submission_id, run_id, ...data } = z
      .object({
        submission_id: text.max(128).optional(),
        run_id: text.optional(),
      })
      .passthrough()
      .parse(req.body);
    const body = schema.parse(data) as { worker?: string; step_id?: string };
    if (run_id && !submission_id) throw new DomainError(422, "Run submission requires an idempotency key");
    return store.submit(req.params.id, operation, submission_id, { ...body, run_id }, () => {
      const run = run_id ? store.validateSubmission(req.params.id, run_id, body, kind, node) : undefined;
      return fn(body, run);
    });
  };
  app.get("/health", () => ({
    status: "ok",
    version: "0.3.0",
    runtime: "node",
    model_configured: !!runtime.value.model.id && !!runtime.value.model.base_url,
  }));
  app.register(
    async (api) => {
      if (auth) {
        api.post("/auth/login", (req, reply) => {
          const body = z
            .object({ username: text.max(128), password: z.string().min(1).max(4096) })
            .strict()
            .parse(req.body);
          if (auth.lockedMs() > 0)
            throw new DomainError(429, `登录失败次数过多，请 ${Math.ceil(auth.lockedMs() / 1000)} 秒后再试。`);
          if (!auth.verify(body.username, body.password)) throw new DomainError(401, "用户名或密码不正确");
          reply.header("Set-Cookie", sessionCookie(auth.issue(), cookieSecure(req)));
          return { authenticated: true, username: auth.username };
        });
        api.post("/auth/logout", (_req, reply) => {
          reply.header("Set-Cookie", clearedCookie);
          return { authenticated: false };
        });
        api.get("/auth/session", (req) => {
          const authenticated = auth.valid(cookieValue(req.headers.cookie));
          return { authenticated, ...(authenticated ? { username: auth.username } : {}) };
        });
        // 内部调用（Dispatcher/Worker）带内部 token；浏览器带会话 Cookie；其余一律 401。
        api.addHook("onRequest", async (req, reply) => {
          if ((req.url || "").split("?")[0].startsWith("/api/auth/")) return;
          if (validInternalToken(workerToken, req.headers["x-tessera-worker-token"])) return;
          // Project capabilities are validated against the URL project by each route.
          if (typeof req.headers["x-tessera-project-token"] === "string") return;
          if (auth.valid(cookieValue(req.headers.cookie))) return;
          await reply.code(401).send({ detail: "需要登录" });
        });
      }
      // The Dispatcher polls /projects with the internal token; the rest of the
      // operator read surface is cookie-only.
      api.get("/projects", (req) => {
        dispatcherCheck(req);
        return store.list();
      });
      api.get("/overview", (req) => {
        operatorCheck(req);
        return store.overview();
      });
      api.get("/findings", (req) => {
        operatorCheck(req);
        return store.allFindings().filter((f) => f.confirmed);
      });
      api.get("/reviews", (req) => {
        operatorCheck(req);
        // A human-approved finding is settled: it must not reappear as pending work.
        return store.allFindings().filter((f) => !f.reviewed && !f.approved && f.review_gate !== "excluded");
      });
      const requireModel = () => {
        try {
          runtime.requireModel();
        } catch (e) {
          throw new DomainError(422, (e as Error).message);
        }
      };
      api.post("/projects", async (req, reply) => {
        operatorCheck(req);
        const graph = store.create(createProjectSchema.parse(req.body), runtime.value.volume_prefix);
        if (!runtime.value.model.id || !runtime.value.model.base_url) store.status(graph.project.id, "stopped");
        reply.code(201).send(store.get(graph.project.id));
      });
      // A project bundle is the whole project: graph, events, diagnostics, Runs,
      // receipts, reports, traffic bodies and evidence originals. Archived entries
      // are inflated during export so the archive is readable without this database.
      api.get<{ Params: { id: string } }>("/projects/:id/bundle", async (req, reply) => {
        operatorCheck(req);
        store.get(req.params.id);
        const directory = bundleTempRoot(store);
        mkdirSync(directory, { recursive: true });
        const file = join(directory, `export-${req.params.id}-${randomUUID()}.zip`);
        try {
          const manifest = await exportProjectBundle(store, req.params.id, file);
          const size = statSync(file).size;
          reply.header("Content-Disposition", `attachment; filename="${req.params.id}-bundle.zip"`);
          reply.header("Content-Length", String(size));
          reply.header("Cache-Control", "no-store");
          reply.header("X-Content-Type-Options", "nosniff");
          reply.header("X-Tessera-Bundle-Warnings", String(manifest.warnings.length));
          reply.header("X-Tessera-Bundle-Evidence-Missing", String(manifest.missing_evidence.length));
          const stream = createReadStream(file);
          const cleanup = () => rmSync(file, { force: true });
          stream.once("close", cleanup);
          stream.once("error", cleanup);
          return reply.type("application/zip").send(stream);
        } catch (error) {
          rmSync(file, { force: true });
          throw error;
        }
      });
      // Build the archive first, then hand back a one-shot URL. The page shows the
      // preparing state itself, so a failure never becomes a navigation to /bundle.
      api.post<{ Params: { id: string } }>("/projects/:id/bundles", async (req, reply) => {
        operatorCheck(req);
        store.get(req.params.id);
        sweepPrepared();
        const directory = bundleTempRoot(store);
        mkdirSync(directory, { recursive: true });
        const bundleId = randomUUID();
        const file = join(directory, `export-${req.params.id}-${bundleId}.zip`);
        let manifest;
        try {
          manifest = await exportProjectBundle(store, req.params.id, file);
        } catch (error) {
          rmSync(file, { force: true });
          throw error;
        }
        preparedBundles.set(bundleId, {
          file,
          project: req.params.id,
          created_at: Date.now(),
          warnings: manifest.warnings.length,
          missing: manifest.missing_evidence.length,
        });
        reply.code(201);
        return {
          bundle_id: bundleId,
          url: `/api/projects/${encodeURIComponent(req.params.id)}/bundles/${bundleId}`,
          filename: `${req.params.id}-bundle.zip`,
          size: statSync(file).size,
          warnings: manifest.warnings,
          missing_evidence: manifest.missing_evidence,
        };
      });
      api.get<{ Params: { id: string; bundleId: string } }>("/projects/:id/bundles/:bundleId", (req, reply) => {
        operatorCheck(req);
        sweepPrepared();
        const entry = preparedBundles.get(req.params.bundleId);
        // One-shot: a prepared file is handed out once and then removed, so a stale
        // URL cannot be replayed or left behind on the data volume.
        if (!entry || entry.project !== req.params.id) throw new DomainError(404, "备份已过期，请重新导出");
        preparedBundles.delete(req.params.bundleId);
        let size: number;
        try {
          size = statSync(entry.file).size;
        } catch {
          throw new DomainError(404, "备份文件已被清理，请重新导出");
        }
        const stream = createReadStream(entry.file);
        const cleanup = () => rmSync(entry.file, { force: true });
        stream.once("close", cleanup);
        stream.once("error", cleanup);
        reply.header("Content-Disposition", `attachment; filename="${req.params.id}-bundle.zip"`);
        reply.header("Content-Length", String(size));
        reply.header("Cache-Control", "no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("X-Tessera-Bundle-Warnings", String(entry.warnings));
        reply.header("X-Tessera-Bundle-Evidence-Missing", String(entry.missing));
        return reply.type("application/zip").send(stream);
      });
      api.post("/projects/import", async (req, reply) => {
        operatorCheck(req);
        const upload = req.body as unknown as NodeJS.ReadableStream | undefined;
        if (!upload || typeof (upload as any)[Symbol.asyncIterator] !== "function")
          throw new DomainError(415, "请上传 ZIP 格式的项目备份文件");
        const configured = Number(process.env.TESSERA_IMPORT_MAX_BYTES || 4 * 1024 * 1024 * 1024);
        const limit = Number.isFinite(configured) && configured > 0 ? configured : 4 * 1024 * 1024 * 1024;
        const directory = bundleTempRoot(store);
        mkdirSync(directory, { recursive: true });
        const file = join(directory, `upload-${randomUUID()}.zip`);
        let received = 0;
        try {
          await pipeline(async function* () {
            for await (const chunk of upload as AsyncIterable<Buffer>) {
              received += chunk.length;
              if (received > limit) throw new DomainError(413, "备份文件超过导入大小上限（TESSERA_IMPORT_MAX_BYTES）");
              yield chunk;
            }
          }, createWriteStream(file));
        } catch (error) {
          rmSync(file, { force: true });
          if (error instanceof DomainError) throw error;
          throw new DomainError(400, "备份文件上传失败");
        }
        try {
          if (!received) throw new DomainError(422, "备份文件为空");
          const result = await importProjectBundle(store, file);
          // Same rule as project creation: an active project without a model would
          // only fail claims. Keep it stopped until the operator configures one.
          if (result.status === "active" && (!runtime.value.model.id || !runtime.value.model.base_url)) {
            store.status(result.project_id, "stopped");
            result.status = "stopped";
          }
          reply.code(201);
          return result;
        } finally {
          rmSync(file, { force: true });
        }
      });
      api.get<{ Params: { id: string } }>("/projects/:id", (req) => {
        projectReadCheck(req, req.params.id);
        return store.view(req.params.id);
      });
      const workspaceCall = async (id: string, operation: string, file: string, limit?: number) => {
        store.get(id);
        const response = await fetch(
          `${process.env.TESSERA_DISPATCHER_URL || "http://127.0.0.1:8001"}/workspace/${encodeURIComponent(id)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tessera-worker-token": workerToken,
              "x-tessera-workspace-signature": workspaceSignature(workspaceKey, id),
            },
            body: JSON.stringify({ operation, path: file, limit }),
            signal: AbortSignal.timeout(35000),
          },
        ).catch(() => {
          throw new DomainError(503, "工作区服务暂不可用，请检查 Dispatcher");
        });
        const data = (await response.json()) as any;
        if (!response.ok) throw new DomainError(response.status, data.detail || "工作区操作失败");
        return data;
      };
      api.get<{ Params: { id: string }; Querystring: { path?: string } }>("/projects/:id/workspace", (req) => {
        operatorCheck(req);
        return workspaceCall(req.params.id, "list", req.query.path || ".");
      });
      api.get<{ Params: { id: string }; Querystring: { path?: string; preview?: string } }>(
        "/projects/:id/workspace/content",
        async (req, reply) => {
          operatorCheck(req);
          const file = z.string().min(1).max(4096).parse(req.query.path);
          const data = await workspaceCall(req.params.id, "read", file, req.query.preview ? 128 * 1024 : undefined);
          if (data.truncated && !req.query.preview)
            throw new DomainError(413, "文件超过 32 MiB，下载未截断；请在工作区分拆或压缩后读取");
          reply
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", "default-src 'none'; sandbox");
          if (req.query.preview) return data;
          reply.header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(file.split("/").at(-1) || "file")}`,
          );
          return reply.type("application/octet-stream").send(Buffer.from(data.content, "base64"));
        },
      );
      api.delete<{ Params: { id: string } }>("/projects/:id/workspace", (req) => {
        operatorCheck(req);
        const body = z
          .object({ path: z.string().min(1).max(4096) })
          .strict()
          .parse(req.body);
        return workspaceCall(req.params.id, "delete", body.path);
      });
      api.get<{ Params: { id: string } }>("/projects/:id/deletion-plan", (req) => {
        operatorCheck(req);
        const graph = store.get(req.params.id),
          prefix = graph.project.deletion?.volume_prefix ?? graph.project.volume_prefix ?? runtime.value.volume_prefix;
        return {
          project_id: req.params.id,
          title: graph.project.title,
          container: `${prefix}-worker-${req.params.id}`,
          workspace_volume: `${prefix}-workspace-${req.params.id}`,
          evidence_count: graph.evidence.length,
          run_count: store.runs(req.params.id).length,
          retry: !!graph.project.deletion,
          error: graph.project.deletion?.error,
        };
      });
      api.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
        operatorCheck(req);
        z.object({ confirmed: z.literal(true) })
          .strict()
          .parse(req.body);
        if (store.db.prepare("SELECT id FROM platform_tombstones WHERE id=?").get(req.params.id))
          return reply.code(204).send();
        let task = deleting.get(req.params.id);
        if (!task) {
          const marker = store.beginDeletion(req.params.id, runtime.value.volume_prefix);
          task = (async () => {
            try {
              const result = options.cleanupProject
                ? await options.cleanupProject(req.params.id, marker.id)
                : await (async () => {
                    const response = await fetch(
                      `${process.env.TESSERA_DISPATCHER_URL || "http://127.0.0.1:8001"}/projects/${encodeURIComponent(req.params.id)}/resources/delete`,
                      {
                        method: "POST",
                        headers: {
                          "content-type": "application/json",
                          "x-tessera-worker-token": workerToken,
                          "x-tessera-workspace-signature": workspaceSignature(workspaceKey, req.params.id),
                        },
                        body: JSON.stringify({ deletion_id: marker.id }),
                        signal: AbortSignal.timeout(90000),
                      },
                    );
                    const data = (await response.json()) as { detail?: string };
                    if (!response.ok) throw new Error(data.detail || "Docker 资源清理失败");
                    return data;
                  })();
              const receipt = z
                .object({
                  project_id: z.literal(req.params.id),
                  deletion_id: z.literal(marker.id),
                  resources_deleted: z.literal(true),
                })
                .passthrough()
                .parse(result);
              if (receipt.resources_deleted) store.remove(req.params.id);
            } catch (error) {
              const detail = `项目删除未完成，项目保持暂停，可重试删除。${error instanceof Error ? error.message.slice(0, 1000) : "资源清理失败"}`;
              store.deletionFailed(req.params.id, detail);
              throw new DomainError(409, detail);
            }
          })();
          deleting.set(req.params.id, task);
        }
        try {
          await task;
          return reply.code(204).send();
        } finally {
          if (deleting.get(req.params.id) === task) deleting.delete(req.params.id);
        }
      });
      api.put<{ Params: { id: string } }>("/projects/:id/title", (req) => {
        operatorCheck(req);
        return store.rename(req.params.id, z.object({ title: text }).parse(req.body).title);
      });
      api.put<{ Params: { id: string } }>("/projects/:id/status", (req) => {
        operatorCheck(req);
        const { status } = z.object({ status: z.enum(["active", "stopped"]) }).parse(req.body);
        if (status === "active") requireModel();
        return store.status(req.params.id, status);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/reopen", (req) => {
        operatorCheck(req);
        const b = z.object({ description: text, creator: text.default("human") }).parse(req.body);
        requireModel();
        store.status(req.params.id, "active");
        store.hint(req.params.id, b.description, b.creator);
        return store.get(req.params.id);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/reaudit", (req) => {
        operatorCheck(req);
        requireModel();
        return store.startReaudit(req.params.id);
      });
      api.delete<{ Params: { id: string } }>("/projects/:id/reaudit", (req) => {
        operatorCheck(req);
        return store.cancelReaudit(req.params.id);
      });
      api.get<{ Params: { id: string }; Querystring: { history?: string } }>("/projects/:id/fgs", (req) => {
        projectReadCheck(req, req.params.id);
        const history = z.enum(["true", "false"]).optional().parse(req.query.history);
        return history === "true" ? store.get(req.params.id) : store.view(req.params.id);
      });
      api.get<{
        Params: { id: string; node: string };
        Querystring: { offset?: string; limit?: string; expected_hash?: string };
      }>("/projects/:id/fgs/history/:node", (req) => {
        projectReadCheck(req, req.params.id);
        const query = z
          .object({
            offset: z.coerce.number().int().nonnegative().default(0),
            limit: z.coerce.number().int().min(1).max(12000).default(4000),
            expected_hash: text.optional(),
          })
          .strict()
          .parse(req.query);
        return readMemoryRecord(
          store.get(req.params.id),
          req.params.node,
          query.offset,
          query.limit,
          query.expected_hash,
          true,
        );
      });
      api.get<{ Params: { id: string }; Querystring: { after?: string } }>("/projects/:id/fgs/events", (req) => {
        operatorCheck(req);
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .default(0)
          .parse(req.query.after ?? 0);
        return store.events(req.params.id, after);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/changes", (req) => {
        workerCheck(req, req.params.id);
        const query = z
          .object({
            after_revision: z.number().int().nonnegative(),
            through_revision: z.number().int().nonnegative(),
            cursor: text.optional(),
            limit: z.number().int().min(0).max(100).optional(),
          })
          .strict()
          .parse(req.body);
        return store.memoryChanges(req.params.id, query);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/changes/read", (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({
            event_seq: z.number().int().positive(),
            offset: z.number().int().nonnegative().default(0),
            limit: z.number().int().min(1).max(12000).default(4000),
          })
          .strict()
          .parse(req.body);
        return store.readMemoryChange(req.params.id, b.event_seq, b.offset, b.limit);
      });
      // Full-text search includes evidence bodies; the runner filters its own snapshot by these ids.
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/search", (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({ keyword: text.max(400), kind: text.max(32).optional() })
          .strict()
          .parse(req.body);
        return store.searchMemory(req.params.id, b.keyword, b.kind);
      });
      // Browsing mode: shuffle the cold pool once, page with a reproducible cursor.
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/peek", (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({
            cursor: text.optional(),
            limit: z.number().int().min(0).max(200).optional(),
            kind: text.optional(),
          })
          .strict()
          .parse(req.body ?? {});
        return store.peekCold(req.params.id, b);
      });
      // Only a real read warms a node; query lists and frontend views never do.
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/read", (req) => {
        workerCheck(req, req.params.id);
        const b = z.object({ id: text }).strict().parse(req.body);
        return store.recordRead(req.params.id, b.id);
      });
      api.put<{ Params: { id: string } }>("/projects/:id/cooldown", (req) => {
        operatorCheck(req);
        const b = z
          .object({
            hot_limit: z.number().int().min(0).max(1000).optional(),
            hot_char_limit: z.number().int().min(0).max(1_000_000).optional(),
            node_id: text.optional(),
            override: z.enum(["auto", "pinned", "cooled"]).optional(),
          })
          .strict()
          .parse(req.body);
        return store.setCooldown(req.params.id, b);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/bookmarks", (req) => {
        workerCheck(req, req.params.id);
        const { run_id } = z.object({ run_id: text }).parse(req.body);
        return commit(req, "bookmark", bookmarkInputSchema, (b) => store.bookmark(req.params.id, run_id, b));
      });
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/deletions/preview", (req) => {
        workerCheck(req, req.params.id);
        const body = deletionPreviewSchema.parse(req.body);
        return store.previewDeletions(req.params.id, body.delete_nodes);
      });
      // The only Decide write contract exposed to the model: plan and settle inside one call.
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/decisions", (req) => {
        workerCheck(req, req.params.id);
        const { run_id, ...data } = z.object({ run_id: text.optional() }).passthrough().parse(req.body);
        const body = submitDecisionsSchema.parse(data);
        return store.submitDecisions(req.params.id, body, run_id);
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/fgs/steps/:step/execute", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `execute:${req.params.step}`,
          executeSchema,
          (b) => store.execute(req.params.id, req.params.step, b),
          "execute",
          req.params.step,
        );
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/fgs/steps/:step/facts", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `fact:${req.params.step}`,
          z
            .object({
              worker: text,
              ...factSubmissionSchema.shape,
            })
            .strict(),
          (b) => store.fact(req.params.id, req.params.step, b),
          "execute",
          req.params.step,
        );
      });
      api.get<{ Params: { id: string; step: string }; Querystring: { limit?: string; run_id?: string } }>(
        "/projects/:id/fgs/steps/:step/traffic",
        (req) => {
          workerCheck(req, req.params.id);
          const step = store.get(req.params.id).steps.find((item) => item.id === req.params.step);
          if (!step) throw new DomainError(404, "Step not found");
          const query = z
            .object({
              limit: z.coerce.number().int().min(1).max(500).default(200),
              run_id: text.optional(),
            })
            .parse(req.query);
          return store.traffic.listForStep(req.params.id, step.id, query.run_id || step.run_id, query.limit);
        },
      );
      api.put<{ Params: { id: string; step: string } }>("/projects/:id/fgs/steps/:step", (req) => {
        operatorCheck(req);
        return store.updateStep(
          req.params.id,
          req.params.step,
          z
            .object({
              priority: z.number().int().optional(),
              discard: z.boolean().optional(),
              reason: text.optional(),
              // 人工改写任务描述：下一次 Decide 入口读到的就是新文本。
              description: text.optional(),
              expected_version: z.number().int().positive().optional(),
            })
            .strict()
            .parse(req.body),
        );
      });
      api.put<{ Params: { id: string; step: string } }>("/projects/:id/fgs/steps/:step/classification", (req) => {
        operatorCheck(req);
        // 人工补测试域：只是分组标签，不需要版本号，也不会让 Decide 重新规划。
        return store.classifyStep(
          req.params.id,
          req.params.step,
          z
            .object({
              test_domain: testDomainSchema.nullable().optional(),
              focus: z.string().trim().max(20).optional(),
            })
            .strict()
            .parse(req.body),
        );
      });
      api.put<{ Params: { id: string; goal: string } }>("/projects/:id/goals/:goal", (req) => {
        operatorCheck(req);
        const b = z.object({ description: text, resume: z.boolean().optional() }).strict().parse(req.body);
        // Saving the new wording never needs a model; resuming a stopped
        // project does, and must fail before anything is written.
        if (b.resume) requireModel();
        return store.editGoal(req.params.id, req.params.goal, b.description, { resume: b.resume });
      });
      api.put<{ Params: { id: string } }>("/projects/:id/origin", (req) => {
        operatorCheck(req);
        const b = z.object({ description: text, resume: z.boolean().optional() }).strict().parse(req.body);
        if (b.resume) requireModel();
        return store.editOrigin(req.params.id, b.description, { resume: b.resume });
      });
      api.post<{ Params: { id: string } }>("/projects/:id/fgs/findings", (req) => {
        operatorCheck(req);
        const finding = store.submitFinding(req.params.id, findingSchema.parse(req.body));
        notifier.notifyNewFinding(finding, projectTitle(req.params.id));
        return finding;
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/fgs/steps/:step/findings", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `finding:${req.params.step}`,
          findingSchema.extend({ worker: text }),
          (b) => {
            const { worker, ...input } = b;
            const finding = store.submitStepFinding(req.params.id, req.params.step, worker, input);
            notifier.notifyNewFinding(finding, projectTitle(req.params.id));
            return finding;
          },
          "execute",
          req.params.step,
        );
      });
      // ─────────────── swarm 模式：平等执行者 ───────────────
      api.get<{ Params: { id: string } }>("/projects/:id/swarm", (req) => {
        projectReadCheck(req, req.params.id);
        return store.swarmView(req.params.id);
      });
      api.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
        "/projects/:id/swarm/messages",
        (req) => {
          projectReadCheck(req, req.params.id);
          const after = Number(req.query.after ?? 0) || 0;
          const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500) || 500));
          return store.swarmMessages(req.params.id, after, limit);
        },
      );
      api.get<{ Params: { id: string; peer: string }; Querystring: { after?: string } }>(
        "/projects/:id/fgs/peers/:peer/inbox",
        (req) => {
          workerCheck(req, req.params.id);
          const after = req.query.after === undefined ? undefined : Number(req.query.after) || 0;
          return store.swarmInbox(req.params.id, req.params.peer, after);
        },
      );
      // peer 回合的录制流量视图：按 peer（traffic-launch 把 step 记为 peer_id）或 run 过滤。
      api.get<{ Params: { id: string; peer: string }; Querystring: { limit?: string; run_id?: string } }>(
        "/projects/:id/fgs/peers/:peer/traffic",
        (req) => {
          workerCheck(req, req.params.id);
          store.get(req.params.id);
          const query = z
            .object({
              limit: z.coerce.number().int().min(1).max(500).default(200),
              run_id: text.optional(),
            })
            .parse(req.query);
          return store.traffic.listForStep(req.params.id, req.params.peer, query.run_id, query.limit);
        },
      );
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/facts", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.fact:${req.params.peer}`,
          z.object({ worker: text, ...factSubmissionSchema.shape, asset_id: text.optional() }).strict(),
          (b, run) => store.swarmFact(req.params.id, req.params.peer, b, run?.id),
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/findings", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.finding:${req.params.peer}`,
          findingSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            const finding = store.swarmFinding(req.params.id, req.params.peer, input, run?.id);
            notifier.notifyNewFinding(finding, projectTitle(req.params.id));
            return finding;
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/messages", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.message:${req.params.peer}`,
          peerMessageSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            return store.swarmSendMessage(req.params.id, req.params.peer, input, run?.id);
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/spawn", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.spawn:${req.params.peer}`,
          peerSpawnSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            return store.swarmSpawn(req.params.id, req.params.peer, input, run?.id);
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/retire", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.retire:${req.params.peer}`,
          peerRetireSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            return store.swarmRetire(req.params.id, req.params.peer, input, run?.id);
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/turn-end", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.turn:${req.params.peer}`,
          peerTurnSchema,
          (b, run) => store.swarmTurnEnd(req.params.id, req.params.peer, b, run!.id),
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/completion/propose", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.propose:${req.params.peer}`,
          completionProposeSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            return store.swarmProposeCompletion(req.params.id, req.params.peer, input, run?.id);
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/completion/respond", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.respond:${req.params.peer}`,
          completionRespondSchema.extend({ worker: text }),
          (b, run) => {
            const { worker: _worker, ...input } = b;
            return store.swarmRespondCompletion(req.params.id, req.params.peer, input, run?.id);
          },
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/assets", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `peer.assets:${req.params.peer}`,
          assetBatchSchema.extend({ worker: text }),
          (b) => store.discover(req.params.id, b.assets),
          "peer",
          req.params.peer,
        );
      });
      api.post<{ Params: { id: string; peer: string } }>("/projects/:id/fgs/peers/:peer/retry", (req) => {
        operatorCheck(req);
        z.object({ confirmed: z.literal(true) })
          .strict()
          .parse(req.body);
        return store.retryPeer(req.params.id, req.params.peer);
      });
      api.get<{ Params: { id: string } }>("/projects/:id/findings/duplicates", (req) => {
        operatorCheck(req);
        return store.duplicateFindings(req.params.id);
      });
      // Exact captured HTTP flows for a Finding, used by the Finding dossier.
      api.get<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/traffic", (req) => {
        operatorCheck(req);
        return store.findingTraffic(req.params.id, req.params.fid);
      });
      api.put<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/details", (req) => {
        operatorCheck(req);
        const { expected_version, ...payload } = z
          .object({ expected_version: z.number().int().positive().optional() })
          .passthrough()
          .parse(req.body);
        const changes = findingSchema
          .omit({ id: true, status: true, from: true, evidence_ids: true, asset_id: true, evidence: true })
          .partial()
          .parse(payload);
        return store.reviseFinding(req.params.id, req.params.fid, changes, expected_version);
      });
      api.post<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/actions", (req) => {
        operatorCheck(req);
        return store.findingAction(req.params.id, req.params.fid, findingActionSchema.parse(req.body));
      });
      // Bulk re-review of informational findings that were passed without Review.
      api.post<{ Params: { id: string } }>("/projects/:id/findings/review", (req) => {
        operatorCheck(req);
        return store.reviewFindings(req.params.id, reviewRequestSchema.parse(req.body));
      });
      // Operator approval: settles this version and removes it from pending queues.
      api.post<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/approval", (req) => {
        operatorCheck(req);
        return store.setFindingApproval(req.params.id, req.params.fid, findingApprovalSchema.parse(req.body));
      });
      // Operator undo for a Finding hidden by Decide deletion; Facts/Steps stay in history.
      api.post<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/restore", (req) => {
        operatorCheck(req);
        const body = z
          .object({ creator: z.string().trim().min(1).max(200).default("human") })
          .strict()
          .parse(req.body ?? {});
        return store.restoreFinding(req.params.id, req.params.fid, body.creator);
      });
      api.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/projects/:id/runs", (req) => {
        operatorCheck(req);
        return store.runs(
          req.params.id,
          z.coerce
            .number()
            .int()
            .min(1)
            .max(1000)
            .parse(req.query.limit || 200),
        );
      });
      api.get<{ Params: { id: string; run: string } }>("/projects/:id/runs/:run", (req) => {
        projectReadCheck(req, req.params.id);
        store.get(req.params.id);
        const run = store.execution.get(req.params.id, req.params.run);
        if (!run) throw new DomainError(404, "Run not found");
        return run;
      });
      api.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string; q?: string; kind?: string } }>(
        "/projects/:id/traffic",
        (req) => {
          operatorCheck(req);
          store.get(req.params.id);
          const query = z
            .object({
              before: z.coerce.number().int().nonnegative().default(0),
              limit: z.coerce.number().int().min(1).max(500).default(200),
              q: z.string().max(200).default(""),
              kind: z.enum(["", "http", "connection", "packet"]).default(""),
            })
            .parse(req.query);
          return {
            records: store.traffic.list(req.params.id, query.before, query.limit, query.q, query.kind),
            capture: store.traffic.status(req.params.id),
          };
        },
      );
      api.post<{ Params: { id: string } }>("/projects/:id/traffic", (req) => {
        workerCheck(req, req.params.id);
        store.get(req.params.id);
        return store.traffic.ingest(
          req.params.id,
          z
            .object({ records: z.array(trafficRecordSchema).min(1).max(8) })
            .strict()
            .parse(req.body).records,
        );
      });
      api.post<{ Params: { id: string; body: string } }>("/projects/:id/traffic/bodies/:body", (req) => {
        workerCheck(req, req.params.id);
        store.get(req.params.id);
        const bodyId = z.string().uuid().parse(req.params.body);
        const chunk = z
          .object({
            offset: z.number().int().nonnegative(),
            data_base64: z
              .string()
              .max(349528)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          })
          .strict()
          .parse(req.body);
        return store.traffic.appendBody(req.params.id, bodyId, chunk.offset, Buffer.from(chunk.data_base64, "base64"));
      });
      api.get<{
        Params: { id: string; flow: string; side: string };
        Querystring: { offset?: string; limit?: string; download?: string };
      }>("/projects/:id/traffic/:flow/:side/body", (req, reply) => {
        operatorCheck(req);
        store.get(req.params.id);
        const side = z.enum(["request", "response"]).parse(req.params.side);
        const record = store.traffic.get(req.params.id, req.params.flow),
          message = record?.[side];
        if (!message) throw new DomainError(404, "Traffic message not found");
        const file = message.body_id ? store.traffic.bodyPath(req.params.id, message.body_id) : undefined;
        const inline = file ? undefined : Buffer.from(message.body_base64, "base64");
        const size = file ? statSync(file).size : inline!.length;
        if (req.query.download === "1") {
          reply
            .type("application/octet-stream")
            .header("Content-Disposition", `attachment; filename="${side}-body.bin"`)
            .header("Content-Length", size);
          return file ? reply.send(createReadStream(file)) : reply.send(inline);
        }
        const offset = z.coerce.number().int().nonnegative().default(0).parse(req.query.offset);
        const limit = z.coerce.number().int().min(1).max(65536).default(65536).parse(req.query.limit);
        const buffer = Buffer.alloc(Math.min(limit, Math.max(0, size - offset)));
        if (file) {
          const fd = openSync(file, "r");
          try {
            readSync(fd, buffer, 0, buffer.length, offset);
          } finally {
            closeSync(fd);
          }
        } else if (buffer.length) inline!.copy(buffer, 0, offset, offset + buffer.length);
        return {
          body_base64: buffer.toString("base64"),
          offset,
          size,
          next: offset + buffer.length < size ? offset + buffer.length : null,
        };
      });
      api.get<{ Params: { id: string } }>("/projects/:id/traffic/status", (req) => {
        operatorCheck(req);
        store.get(req.params.id);
        return store.traffic.status(req.params.id);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/traffic/status", (req) => {
        workerCheck(req, req.params.id);
        store.get(req.params.id);
        return store.traffic.setStatus(req.params.id, trafficStatusSchema.parse(req.body));
      });
      // Explicit one-shot replay: sends the stored or operator-edited request and
      // returns the actual response without archiving it. Operator-only; never
      // triggered by a model.
      api.post<{ Params: { id: string; flow: string } }>("/projects/:id/traffic/:flow/resend", async (req) => {
        operatorCheck(req);
        const edited =
          req.body == null
            ? undefined
            : z
                .object({
                  request: z
                    .string()
                    .max(9 * 1024 * 1024)
                    .optional(),
                })
                .strict()
                .parse(req.body).request;
        return store.resendTraffic(req.params.id, req.params.flow, edited);
      });
      api.get<{ Params: { id: string; flow: string } }>("/projects/:id/traffic/:flow", (req) => {
        operatorCheck(req);
        store.get(req.params.id);
        const record = store.traffic.get(req.params.id, req.params.flow);
        if (!record) throw new DomainError(404, "Traffic record not found");
        return record;
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/diagnostics", (req) => {
        workerCheck(req, req.params.id);
        const body = z
          .object({
            job: jobSchema,
            event: diagnosticSchema.optional(),
            events: z.array(diagnosticSchema).min(1).max(16).optional(),
          })
          .strict()
          .refine((b) => !!b.event !== !!b.events, "Provide event or events, not both")
          .parse(req.body);
        const { job } = body,
          events = body.events ?? [body.event!];
        if (!job.run_id) throw new DomainError(422, "Diagnostic requires a Run");
        const run = store.execution.get(req.params.id, job.run_id);
        if (
          !run ||
          job.project_id !== req.params.id ||
          run.worker !== job.worker ||
          run.kind !== job.kind ||
          run.graph_id !== job.graph_id ||
          (job.kind === "execute" && run.node_id !== job.step_id) ||
          (job.kind === "review" && (run.node_id !== job.finding_id || run.finding_version !== job.finding_version))
        )
          throw new DomainError(409, "Diagnostic Run identity mismatch");
        if (events.some((event) => JSON.stringify(event).length > 16000))
          throw new DomainError(422, "Diagnostic event too large");
        store.transaction(() => {
          for (const event of events) {
            diagnostics.save(req.params.id, run.id, event);
            if (["context_usage", "compaction_start", "compaction_end"].includes(event.type)) {
              const d = event.data;
              run.capacity = {
                current: typeof d.current === "number" ? d.current : null,
                peak: typeof d.peak === "number" ? d.peak : null,
                generation: Number(d.generation) || 0,
                source: String(d.source || "unknown"),
              };
              store.execution.save(run);
            }
          }
        });
        return { ok: true };
      });
      // Live control-plane view without re-exporting a project's diagnostics.
      api.get("/control-plane/timing", (req) => {
        operatorCheck(req);
        return { ...controlPlane.snapshot(), stages: runMetrics(store.db) };
      });
      api.get<{ Params: { id: string }; Querystring: { after?: string } }>(
        "/projects/:id/diagnostics",
        (req, reply) => {
          operatorCheck(req);
          const project = req.params.id;
          store.get(project);
          const after = z.coerce
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .parse(req.query.after || 0);
          const through = diagnostics.highwater(project);
          async function* lines() {
            yield JSON.stringify({
              type: "manifest",
              schema: "tessera.diagnostics.v2",
              project_id: project,
              server_build: diagnosticBuild,
              exported_at: new Date().toISOString(),
              after,
              through,
              control_plane: controlPlane.snapshot(),
              trace_format:
                "Join validation_trace by run_id/source_id/trace_id, ordered by part. Verify parts/offset/recorded_chars and log_sha256 only when not truncated. Hashes describe redacted log copies, not original Evidence.",
              completeness:
                "Summaries cover all stored events through highwater, including events before after. Missing tails, chunks, unknown usage and truncation stay unknown; accepted submissions do not prove semantic accuracy.",
              note: "Diagnostic excerpts, not original evidence. Events are best-effort; missing events do not prove no action. Raw traces remain in /workspace/runs/<worker>/. Run rows are current snapshots.",
            }) + "\n";
            // 运行日志里带一条测试域覆盖快照：导出文件本身就能回答「各域做了多少、多少没分类」。
            const coverage = domainStats(store.get(project));
            yield JSON.stringify({
              type: "domain_coverage",
              schema: "tessera.domain-coverage.v1",
              project_id: project,
              generated_at: new Date().toISOString(),
              tasks: {
                total: coverage.total,
                classified: coverage.classified,
                unclassified: coverage.unclassified,
                discarded: coverage.discarded,
              },
              other_ratio: Number(coverage.otherRatio.toFixed(4)),
              core_domains: {
                used: coverage.used,
                total: coverage.coreTotal,
                coverage_ratio: Number(coverage.coverage.toFixed(4)),
              },
              cross_domain_tasks: coverage.crossDomain,
              domains: coverage.domains.map((domain) => ({
                domain: domain.key,
                steps: domain.steps,
                facts: domain.facts,
                findings: domain.findings,
                task_share: Number(domain.share.toFixed(4)),
              })),
              note: "Current active graph; deleted and discarded Steps are excluded. Facts and Findings inherit their producing Step's test_domain; a missing test_domain counts as other.",
            }) + "\n";
            // 每 Step 的执行成本：导出文件自身就能排出最长的 Step，不需要另做 join。
            const stepRuns = store.db
              .prepare("SELECT data FROM platform_runs WHERE project_id=? ORDER BY rowid")
              .all(project)
              .map((row) => JSON.parse(String(row.data)) as Run);
            const costs = stepCosts(store.get(project), stepRuns, diagnostics.runCosts(project, through));
            yield JSON.stringify({
              type: "step_costs",
              schema: "tessera.step-costs.v1",
              project_id: project,
              generated_at: new Date().toISOString(),
              ...costs,
              note: "Execute Runs are grouped by Step and sorted by compaction count, then input tokens. Compaction counts come from diagnostic events; Runs without events fall back to the Pi session generation. Missing usage is counted in unknown_usage_runs, never as zero. Context failures are classified from the Run error; wall time only counts finished Runs.",
            }) + "\n";
            let cursor = after;
            while (cursor < through) {
              const rows = diagnostics.page(project, cursor, through);
              if (!rows.length) break;
              for (const row of rows) yield JSON.stringify(row) + "\n";
              cursor = rows.at(-1)!.seq;
            }
            const summaries = new Map(diagnostics.summaries(project, through).map((s) => [s.run_id, s]));
            let runCursor = 0;
            const runThrough = Number(
              store.db.prepare("SELECT MAX(rowid) AS n FROM platform_runs WHERE project_id=?").get(project)?.n || 0,
            );
            while (runCursor < runThrough) {
              const rows = store.db
                .prepare(
                  "SELECT rowid AS cursor,data FROM platform_runs WHERE project_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 1000",
                )
                .all(project, runCursor, runThrough);
              if (!rows.length) break;
              for (const row of rows) {
                const run = JSON.parse(String(row.data));
                yield JSON.stringify({ type: "run_snapshot", ...run }) + "\n";
                yield JSON.stringify(
                  summaries.get(run.id) ?? {
                    type: "run_diagnostic_summary",
                    run_id: run.id,
                    event_count: 0,
                    sources: [],
                    note: "No diagnostics stored: old worker, initialization or delivery failure; unknown.",
                  },
                ) + "\n";
              }
              runCursor = Number(rows.at(-1)!.cursor);
            }
            yield JSON.stringify({ type: "export_end", through, next_after: Math.max(after, through) }) + "\n";
          }
          reply.header("Content-Disposition", `attachment; filename="${project}-diagnostics.ndjson.gz"`);
          reply.header("X-Content-Type-Options", "nosniff");
          const source = Readable.from(lines()),
            compressed = createGzip();
          source.once("error", (error) => compressed.destroy(error));
          compressed.once("close", () => source.destroy());
          return reply.type("application/gzip").send(source.pipe(compressed));
        },
      );
      // 项目概览的工具调用排行：只聚合计数，不把整份诊断导出给浏览器。
      api.get<{ Params: { id: string } }>("/projects/:id/tool-usage", (req): ToolUsageReport => {
        operatorCheck(req);
        store.get(req.params.id);
        const through = diagnostics.highwater(req.params.id);
        const tools = diagnostics.toolUsage(req.params.id, through);
        const totals = tools.reduce(
          (sum, tool) => ({
            tools: sum.tools + 1,
            calls: sum.calls + tool.calls,
            ended: sum.ended + tool.ended,
            errors: sum.errors + tool.errors,
            timed: sum.timed + tool.timed,
            elapsed_ms: sum.elapsed_ms + tool.elapsed_ms,
          }),
          { tools: 0, calls: 0, ended: 0, errors: 0, timed: 0, elapsed_ms: 0 },
        );
        return {
          through,
          tools,
          totals,
          note: "Calls count tool_start events. Errors and elapsed time come from tool_end events for the same tool; calls without an observed end stay unknown. Missing diagnostics are not backfilled.",
        };
      });
      api.post<{ Params: { id: string; run: string } }>("/projects/:id/runs/:run/retry", (req) => {
        operatorCheck(req);
        z.object({ confirmed: z.literal(true) })
          .strict()
          .parse(req.body);
        return store.retryRun(req.params.id, req.params.run);
      });
      api.get<{ Params: { id: string } }>("/projects/:id/reports", (req) => {
        operatorCheck(req);
        return reports.list(req.params.id);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/reports", (req) => {
        operatorCheck(req);
        z.object({})
          .strict()
          .parse(req.body || {});
        return reports.create(req.params.id);
      });
      api.get<{ Params: { id: string; report: string } }>("/projects/:id/reports/:report", (req) => {
        operatorCheck(req);
        return reports.get(req.params.id, req.params.report);
      });
      api.get<{ Params: { id: string; report: string }; Querystring: { format?: string } }>(
        "/projects/:id/reports/:report/content",
        (req, reply) => {
          operatorCheck(req);
          const format = z.enum(["markdown", "zip"]).parse(req.query.format || "markdown");
          const report = reports.get(req.params.id, req.params.report);
          reply.header("Content-Disposition", `attachment; filename="${report.id}.${format === "zip" ? "zip" : "md"}"`);
          reply.header("X-Content-Type-Options", "nosniff");
          return format === "zip"
            ? reply.type("application/zip").send(reports.archive(report))
            : reply.type("text/markdown; charset=utf-8").send(reports.markdown(report));
        },
      );
      api.post<{ Params: { id: string } }>("/projects/:id/hints", (req) => {
        operatorCheck(req);
        const b = hintSchema.parse(req.body);
        return store.hint(req.params.id, b.content, b.creator, b.priority);
      });
      api.put<{ Params: { id: string; hid: string } }>("/projects/:id/hints/:hid", (req) => {
        operatorCheck(req);
        return store.updateHint(req.params.id, req.params.hid, hintUpdateSchema.parse(req.body));
      });
      api.delete<{ Params: { id: string; hid: string } }>("/projects/:id/hints/:hid", (req) => {
        operatorCheck(req);
        return store.updateHint(req.params.id, req.params.hid, hintUpdateSchema.parse(req.body || {}), true);
      });
      // Closing a human directive is an operator decision. The model can only
      // leave advice in hint_notes, so this route is the sole non-manual closure.
      api.post<{ Params: { id: string; hid: string } }>("/projects/:id/hints/:hid/resolve", (req) => {
        operatorCheck(req);
        return store.resolveHint(req.params.id, req.params.hid, hintResolveSchema.parse(req.body || {}));
      });
      api.delete<{ Params: { id: string; hid: string } }>("/projects/:id/hints/:hid/resolve", (req) => {
        operatorCheck(req);
        return store.reopenHint(req.params.id, req.params.hid, hintResolveSchema.parse(req.body || {}));
      });
      // A Review planning issue is mandatory input for Decide. The model may
      // explain a low-risk dismissal itself, but authorization / IDOR / PII
      // issues can only be dismissed by the operator through this route.
      api.post<{ Params: { id: string; rid: string; index: string } }>(
        "/projects/:id/reviews/:rid/issues/:index/waive",
        (req) => {
          operatorCheck(req);
          return store.waiveReviewIssue(
            req.params.id,
            req.params.rid,
            z.coerce.number().int().nonnegative().parse(req.params.index),
            reviewIssueWaiverSchema.parse(req.body || {}),
          );
        },
      );
      api.delete<{ Params: { id: string; rid: string; index: string } }>(
        "/projects/:id/reviews/:rid/issues/:index/waive",
        (req) => {
          operatorCheck(req);
          return store.reopenReviewIssue(
            req.params.id,
            req.params.rid,
            z.coerce.number().int().nonnegative().parse(req.params.index),
          );
        },
      );
      api.get<{ Params: { id: string } }>("/projects/:id/assets", (req) => {
        operatorCheck(req);
        return store.get(req.params.id).assets;
      });
      api.post<{ Params: { id: string } }>("/projects/:id/assets", (req) => {
        workerCheck(req, req.params.id);
        // Asset discovery is an Execute observation. It goes through the same
        // Run lease and idempotency gate as facts, so a closed Step or expired
        // lease cannot keep writing scope.
        return commit(
          req,
          "assets.discovered",
          assetBatchSchema.extend({ worker: text }),
          (b, run) =>
            store.discover(req.params.id, b.assets, {
              ...(run?.node_id ? { producer: { step_id: run.node_id, worker: run.worker } } : {}),
            }),
          "execute",
        );
      });
      api.post<{ Params: { id: string } }>("/projects/:id/assets/approve", (req) => {
        operatorCheck(req);
        return store.approve(req.params.id, z.object({ ids: z.array(text).min(1) }).parse(req.body).ids);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/evidence", (req) => {
        const body = req.body as { run_id?: string };
        // A Run-bound upload is a Worker call. A manual upload is an operator action
        // and must not be available to the model through the shared token.
        if (body.run_id) workerCheck(req, req.params.id);
        else operatorCheck(req);
        return commit(req, "evidence", evidenceSchema, (b) => store.addEvidence(req.params.id, b));
      });
      api.post<{ Params: { id: string } }>("/projects/:id/assets/revoke", (req) => {
        operatorCheck(req);
        return store.revokeAssets(
          req.params.id,
          z
            .object({ ids: z.array(text).min(1) })
            .strict()
            .parse(req.body).ids,
        );
      });
      // 冷处理与撤销分开：冷处理只影响规划入口，批准状态仍由人掌握。
      api.put<{ Params: { id: string; aid: string } }>("/projects/:id/assets/:aid", (req) => {
        operatorCheck(req);
        const body = z
          .object({ cooldown_override: z.enum(["auto", "cooled"]), reason: text.optional() })
          .strict()
          .parse(req.body);
        return store.setAssetInterest(req.params.id, req.params.aid, body.cooldown_override, body.reason);
      });
      api.get<{ Params: { id: string; eid: string } }>("/projects/:id/evidence/:eid/content", (req, reply) => {
        projectReadCheck(req, req.params.id);
        const { metadata, bytes } = store.evidenceContent(req.params.id, req.params.eid);
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
        return reply.type(metadata.mime_type).send(bytes);
      });
      api.post<{ Params: { id: string; fid: string } }>("/projects/:id/findings/:fid/review", (req) => {
        workerCheck(req, req.params.id);
        return commit(
          req,
          `review:${req.params.fid}`,
          reviewSchema,
          (b) => store.review(req.params.id, req.params.fid, b),
          "review",
          req.params.fid,
        );
      });
      api.post<{ Params: { id: string } }>("/projects/:id/intents", (req) => {
        operatorCheck(req);
        return store.manualStep(
          req.params.id,
          z
            .object({
              from: z.array(text).min(1),
              description: text,
              priority: z.number().int().optional(),
              creator: text,
              claim: z.boolean().optional(),
              asset_id: text.optional(),
            })
            .parse(req.body),
        );
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/intents/:step/heartbeat", (req) => {
        operatorCheck(req);
        return store.manualHeartbeat(req.params.id, req.params.step, z.object({ worker: text }).parse(req.body).worker);
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/intents/:step/release", (req) => {
        operatorCheck(req);
        return store.manualRelease(req.params.id, req.params.step, z.object({ worker: text }).parse(req.body).worker);
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/intents/:step/conclude", (req) => {
        operatorCheck(req);
        const b = z.object({ worker: text, description: text }).parse(req.body);
        return store.manualConclude(req.params.id, req.params.step, b.worker, b.description);
      });
      // Human close/reopen: the decider's action, not an execution result.
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/steps/:step/close", (req) => {
        operatorCheck(req);
        const b = z
          .object({
            worker: text.default("human"),
            reason: text,
            evidence_ids: z.array(text).default([]),
            expected_version: z.number().int().positive().optional(),
          })
          .strict()
          .parse(req.body);
        return store.closeStep(req.params.id, req.params.step, b);
      });
      api.post<{ Params: { id: string; step: string } }>("/projects/:id/steps/:step/reopen", (req) => {
        operatorCheck(req);
        const b = z
          .object({
            worker: text.default("human"),
            reason: text,
            expected_version: z.number().int().positive().optional(),
          })
          .strict()
          .parse(req.body);
        return store.reopenStep(req.params.id, req.params.step, b);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/complete", (req) => {
        operatorCheck(req);
        const b = z
          .object({
            from: z.array(text).min(1),
            description: text,
            worker: text,
          })
          .parse(req.body);
        return store.manualComplete(req.params.id, b.from, b.description, b.worker);
      });
      api.get("/settings", (req) => {
        operatorCheck(req);
        return store.settings();
      });
      api.get("/runtime/compatibility", (req) => {
        operatorCheck(req);
        const rows = store.db.prepare("SELECT id,data FROM platform_projects").all();
        let incompatible = 0,
          requeued = 0;
        for (const row of rows) {
          const header = JSON.parse(String(row.data));
          if (header.format_version !== 1) {
            incompatible++;
            continue;
          }
          const graph = store.get(String(row.id));
          requeued += graph.findings.filter(
            (f) => !f.deleted && !f.merged_into && !f.withdrawn_at && classificationReviewRequired(f, graph),
          ).length;
        }
        return { incompatible, requeued };
      });
      api.put("/settings", (req) => {
        operatorCheck(req);
        return store.setSettings(
          z
            .object({
              // A lease below 30s cannot cover one slow control-plane write plus
              // a heartbeat retry; letting the UI set it that low pauses projects.
              intent_timeout: z.number().int().min(30),
              reason_timeout: z.number().int().min(30),
            })
            .parse(req.body),
        );
      });
      registerRuntimeRoutes(api, runtime, operatorCheck, workerCheck, (value) => {
        store.setSkipInformationalReview(value.skip_informational_review === true);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/claim", async (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({
            worker: text,
            debounce_ms: z.number().int().min(0).default(1500),
            claim_id: text.max(128).optional(),
          })
          .parse(req.body);
        requireModel();
        const job = store.claim(req.params.id, b.worker, b.debounce_ms, runtime.value, b.claim_id);
        if (!job) return job;
        const config = structuredClone(runtime.value);
        pinRunModel(store, job, job.kind === "review" ? config.review_model || config.model : config.model);
        return { ...job, worker_config: await workerConfig(job, config, workerToken) };
      });
      // Idempotent cancel for a claim the dispatcher abandoned after a timeout.
      api.post<{ Params: { id: string; claim: string } }>("/projects/:id/jobs/claim/:claim/cancel", (req) => {
        workerCheck(req, req.params.id);
        const b = z.object({ worker: text }).parse(req.body);
        return store.cancelClaim(req.params.id, b.worker, req.params.claim);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/heartbeat", (req) => {
        workerCheck(req, req.params.id);
        return store.heartbeat(req.params.id, jobSchema.parse(req.body));
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/started", (req) => {
        workerCheck(req, req.params.id);
        const body = z
          .object({ job: jobSchema, session_path: text.max(4096) })
          .strict()
          .parse(req.body);
        return store.runStarted(req.params.id, body.job, body.session_path);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/action", (req) => {
        workerCheck(req, req.params.id);
        return store.externalAction(req.params.id, jobSchema.parse(req.body));
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/release", (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({ job: jobSchema, error: text.optional(), conflict: z.boolean().default(false) })
          .parse(req.body);
        return store.release(req.params.id, b.job, b.error, b.conflict);
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/usage", (req) => {
        workerCheck(req, req.params.id);
        const b = z
          .object({
            job: jobSchema,
            input: z.number().nonnegative().nullable(),
            input_uncached: z.number().nonnegative().nullable().optional(),
            cache_read: z.number().nonnegative().nullable().optional(),
            cache_write: z.number().nonnegative().nullable().optional(),
            output: z.number().nonnegative().nullable(),
            cost: z.number().nonnegative().nullable(),
            request_id: text.max(128).optional(),
            stage: z.enum(["started", "completed"]).default("completed"),
          })
          .parse(req.body);
        if (
          b.stage === "started" &&
          [b.input, b.output, b.cost, b.input_uncached, b.cache_read, b.cache_write].some((v) => v != null)
        )
          throw new DomainError(422, "Started requests have unknown usage");
        if (
          b.input !== null &&
          b.input_uncached != null &&
          b.cache_read != null &&
          b.cache_write != null &&
          b.input !== b.input_uncached + b.cache_read + b.cache_write
        )
          throw new DomainError(422, "Input total differs from disjoint usage buckets");
        return store.usage(req.params.id, b.job, b.input, b.output, b.cost, b.request_id, b.stage, {
          input_uncached: b.input_uncached ?? null,
          cache_read: b.cache_read ?? null,
          cache_write: b.cache_write ?? null,
        });
      });
      api.post<{ Params: { id: string } }>("/projects/:id/jobs/view", (req) => {
        workerCheck(req, req.params.id);
        const job = jobSchema.parse(req.body),
          graph = store.get(req.params.id);
        if (job.project_id !== req.params.id) throw new DomainError(422, "Job project does not match request project");
        const { items: _items, ...changes } = store.memoryChanges(req.params.id, {
          after_revision: graph.decided_revision,
          through_revision: graph.observation_revision,
          limit: 0,
        });
        return memoryEntry(graph, job, changes);
      });
      api.get<{ Params: { id: string }; Querystring: { format?: string } }>("/projects/:id/export", (req, reply) => {
        operatorCheck(req);
        const g = store.get(req.params.id),
          format = req.query.format || "fgs";
        reply.header(
          "Content-Disposition",
          `attachment; filename="${g.project.id}.${["vulnerabilities", "findings", "json"].includes(format) ? "json" : format === "timeline" ? "txt" : "yaml"}"`,
        );
        if (format === "vulnerabilities") return g.findings.filter((f) => confirmedVulnerability(f, g));
        if (format === "findings")
          return store
            .view(req.params.id)
            .findings.filter((f) => !f.merged_into && !f.withdrawn_at)
            .map((f) => ({
              ...f,
              kind: findingKind(f),
              classification_review_required: classificationReviewRequired(f, g),
            }));
        if (format === "json") return g;
        if (format === "timeline")
          return reply.type("text/plain").send(
            store
              .events(req.params.id)
              .map((e) => `${e.created_at} ${e.kind}\n${JSON.stringify(e.data, null, 2)}`)
              .join("\n\n"),
          );
        return reply.type("text/yaml").send(stringify(g));
      });
      api.get("/events", async (req, reply) => {
        operatorCheck(req);
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        reply.raw.write("retry: 3000\n\n");
        let previous = "";
        const timer = setInterval(() => {
          const token = store.changeToken();
          if (token !== previous) {
            previous = token;
            reply.raw.write(`event: refresh\ndata: ${token}\n\n`);
          } else reply.raw.write(": keepalive\n\n");
        }, 2000);
        const cleanup = () => clearInterval(timer);
        req.raw.on("close", cleanup);
        reply.raw.on("close", cleanup);
      });
    },
    { prefix: "/api" },
  );
  if (existsSync(web)) {
    app.register(staticFiles, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url === "/api" || req.url.startsWith("/api/")
        ? reply.code(404).send({ detail: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
