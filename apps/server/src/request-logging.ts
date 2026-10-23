import type { FastifyInstance } from "fastify";
import { redactModelError } from "../../../packages/protocol/src/model-errors.js";
import { ZodError } from "zod";

/** No request bodies, query strings, cookies, headers or upstream payloads in control logs. */
export function requestLogging(app: FastifyInstance, secrets: () => string[]) {
  const started = new WeakMap<object, number>();
  app.addHook("onRequest", async (req) => {
    started.set(req, performance.now());
  });
  app.addHook("onError", async (req, reply, error) => {
    if (error instanceof ZodError || (error.statusCode || 500) < 500) return;
    req.log.error(
      {
        request_id: req.id,
        method: req.method,
        route: req.routeOptions.url || "(unmatched)",
        status: error.statusCode || 500,
        error: redactModelError(error.message, secrets()).slice(0, 1500),
      },
      "request_error",
    );
  });
  app.addHook("onResponse", async (req, reply) => {
    const elapsed_ms = Math.round(performance.now() - (started.get(req) ?? performance.now()));
    const data = {
      request_id: req.id,
      method: req.method,
      route: req.routeOptions.url || "(unmatched)",
      status: reply.statusCode,
      elapsed_ms,
    };
    if (reply.statusCode === 401 || reply.statusCode === 403) req.log.warn(data, "authentication_failed");
    else if (reply.statusCode >= 500) req.log.error(data, "request_failed");
    else if (elapsed_ms >= 500) req.log.warn(data, "slow_request");
  });
}
