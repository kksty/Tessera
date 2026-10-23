import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { LogController } from "fastify";
import { requestLogging } from "../../apps/server/src/request-logging.js";

test("control logs include request failures/auth/slow routes and omit credentials, bodies and query strings", async () => {
  const entries: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          entries.push(line);
        },
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  requestLogging(app, () => ["model-secret"]);
  app.get("/failure", () => {
    throw new Error("upstream model-secret failed");
  });
  app.get("/denied", (_req, reply) => reply.code(403).send({}));
  app.get("/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 510));
    return {};
  });
  app.setErrorHandler((_error, _req, reply) => reply.code(500).send({ detail: "Internal server error" }));
  try {
    await app.inject({
      url: "/failure?secret=query-secret",
      headers: { authorization: "Bearer header-secret", cookie: "cookie-secret" },
    });
    await app.inject("/denied");
    await app.inject("/slow");
    const logs = entries.join("");
    for (const expected of [
      "request_error",
      "authentication_failed",
      "slow_request",
      "request_id",
      "/failure",
      "elapsed_ms",
    ])
      assert.ok(logs.includes(expected));
    for (const secret of ["model-secret", "query-secret", "header-secret", "cookie-secret"])
      assert.ok(!logs.includes(secret));
  } finally {
    await app.close();
  }
});
