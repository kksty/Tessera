import { test } from "node:test";
import assert from "node:assert/strict";
import { toolEnvironment } from "../../packages/runner/src/tool-environment.js";

test("tool env is a whitelist, preserving operational proxy/CA/Windows paths without control or provider credentials", () => {
  const source = {
    Path: "bin",
    SystemRoot: "windows",
    HTTPS_PROXY: "http://recorder:8081",
    SSL_CERT_FILE: "ca.pem",
    LC_ALL: "C.UTF-8",
    TESSERA_RUN_CONFIG: "encoded-key",
    TESSERA_PROJECT_TOKEN: "project",
    TESSERA_WORKER_TOKEN: "global",
    PI_API_KEY: "main",
    PI_REVIEW_API_KEY: "review",
    OPENAI_API_KEY: "other",
    AWS_SECRET_ACCESS_KEY: "secret",
    NODE_OPTIONS: "injected",
  };
  assert.deepEqual(toolEnvironment(source), {
    Path: "bin",
    SystemRoot: "windows",
    HTTPS_PROXY: "http://recorder:8081",
    SSL_CERT_FILE: "ca.pem",
    LC_ALL: "C.UTF-8",
  });
});
