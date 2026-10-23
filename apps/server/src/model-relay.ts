import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import type { Store } from "../../../packages/core/src/store.js";
import { DomainError } from "../../../packages/core/src/errors.js";
import { modelRunToken, validInternalToken } from "../../../packages/protocol/src/internal-auth.js";
import { configuredModel } from "../../../packages/models/src/runtime.js";
import type { RuntimeConfig } from "./runtime.js";
import { modelResponseRedaction } from "./model-redaction.js";
import { redactModelError } from "../../../packages/protocol/src/model-errors.js";
import type { Job } from "../../../packages/protocol/src/index.js";
import type { ModelConfig } from "../../../packages/protocol/src/model-config.js";

export function pinRunModel(store: Store, job: Job, cfg: ModelConfig) {
  store.db.prepare("INSERT OR IGNORE INTO platform_run_models VALUES(?,?)").run(job.run_id!, JSON.stringify(cfg));
}

/** Fixed-destination, Run-scoped relay. Neither request URLs nor headers select an upstream. */
export function registerModelRelay(app: FastifyInstance, store: Store, runtime: RuntimeConfig, secret: string) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS platform_run_models(
    run_id TEXT PRIMARY KEY REFERENCES platform_runs(id) ON DELETE CASCADE,data TEXT NOT NULL);`);
  app.post<{ Params: { project: string; run: string; "*": string } }>(
    "/api/model/:project/:run/*",
    async (req, reply) => {
      const { project, run: runId } = req.params;
      const expected = modelRunToken(secret, project, runId);
      const supplied = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer /, "");
      if (
        !validInternalToken(expected, supplied) &&
        !validInternalToken(`sk-ant-oat-${expected}`, supplied) &&
        !validInternalToken(`sk-${expected}`, supplied)
      )
        throw new DomainError(403, "Model Run credential required");
      const run = store.validateSubmission(project, runId, {});
      const graph = store.get(project);
      if (graph.project.status !== "active" || graph.project.deletion)
        throw new DomainError(409, "Project is not active");
      const lease =
        run.kind === "decide"
          ? graph.project.reason?.last_heartbeat_at
          : run.kind === "execute"
            ? graph.steps.find((s) => s.id === run.node_id)?.last_heartbeat_at
            : graph.findings.find((f) => f.id === run.node_id)?.review_heartbeat;
      const ttl = run.kind === "decide" ? store.settings().reason_timeout : store.leaseSeconds;
      if (!lease || Date.now() - Date.parse(lease) > ttl * 1000) throw new DomainError(409, "Run lease expired");
      const snapshot = store.db.prepare("SELECT data FROM platform_run_models WHERE run_id=?").get(runId);
      const cfg: ModelConfig = snapshot
        ? JSON.parse(String(snapshot.data))
        : run.kind === "review"
          ? runtime.value.review_model || runtime.value.model
          : runtime.value.model;
      if (!snapshot) pinRunModel(store, { run_id: runId } as Job, cfg);
      const { model } = await configuredModel(cfg);
      const endpoint =
        model.api === "anthropic-messages"
          ? "v1/messages"
          : model.api === "openai-responses"
            ? "responses"
            : "chat/completions";
      const query = new URL(req.url, "http://relay.invalid").search;
      if (req.params["*"] !== endpoint || (query && !(model.api === "anthropic-messages" && query === "?beta=true")))
        throw new DomainError(404, "Unknown model endpoint");
      const body = req.body as Record<string, unknown> | null;
      if (!body || body.model !== cfg.id) throw new DomainError(422, "Model does not belong to this Run");
      const secrets = [cfg.api_key, runtime.value.model.api_key, runtime.value.review_model?.api_key || ""];
      const headers: Record<string, string> = { ...model.headers, "content-type": "application/json" };
      for (const name of [
        "anthropic-version",
        "anthropic-beta",
        "openai-beta",
        "anthropic-dangerous-direct-browser-access",
        "x-app",
        "user-agent",
        "x-initiator",
        "x-interaction-type",
        "copilot-vision-request",
      ])
        if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
      if (cfg.api_key) {
        if (
          model.api === "anthropic-messages" &&
          !cfg.api_key.includes("sk-ant-oat") &&
          model.provider !== "github-copilot"
        )
          headers["x-api-key"] = cfg.api_key;
        else headers.authorization = `Bearer ${cfg.api_key}`;
      }
      const cancel = new AbortController();
      const aborted = () => cancel.abort();
      reply.raw.once("close", aborted);
      try {
        const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}/${endpoint}${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(600000)]),
        });
        if (!upstream.ok) {
          const reader = upstream.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (reader && size < 65536) {
              const chunk = await reader.read();
              if (chunk.done) break;
              chunks.push(chunk.value.subarray(0, 65536 - size));
              size += chunk.value.length;
            }
          } finally {
            await reader?.cancel();
          }
          const message = Buffer.concat(chunks).toString("utf8");
          const clean = (value: unknown): unknown =>
            typeof value === "string"
              ? redactModelError(value, secrets)
              : Array.isArray(value)
                ? value.map(clean)
                : value && typeof value === "object"
                  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
                  : value;
          if (size < 65536) {
            try {
              return reply.code(upstream.status).send(clean(JSON.parse(message)));
            } catch {
              /* A text gateway error still retains its useful diagnostic message. */
            }
          }
          return reply.code(upstream.status).send({
            error: {
              message:
                size >= 65536
                  ? "Model upstream error exceeds limit"
                  : redactModelError(message || "Model upstream request failed", secrets),
              type: "upstream_error",
            },
          });
        }
        reply.header("content-type", upstream.headers.get("content-type") || "application/json");
        reply.header("cache-control", "no-store");
        if (!upstream.body) return reply.code(502).send({ detail: "Empty model upstream response" });
        const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
        const redacted = modelResponseRedaction(secrets);
        source.on("error", () => redacted.destroy(new Error("Model response stream failed")));
        redacted.once("close", () => source.destroy());
        return reply.send(source.pipe(redacted));
      } catch {
        throw new DomainError(502, "Model upstream unavailable");
      }
    },
  );
}
