const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { resolve } = require("node:path");
const fs = require("node:fs");
const run = randomUUID().slice(0, 8),
  project = "tessera-qa-" + run,
  network = project + "-network",
  model = project + "-model";
const env = {
  ...process.env,
  TESSERA_BIND_ADDRESS: "127.0.0.1",
  TESSERA_PORT: "8788",
  TESSERA_NETWORK: network,
  TESSERA_VOLUME_PREFIX: project,
  TESSERA_DATA_DIR: resolve("test-results/docker/" + run),
  PI_MODEL: "",
  PI_BASE_URL: "",
  PI_API_KEY: "",
  TESSERA_WORKER_TOKEN: "",
  TESSERA_OPERATOR_USER: "qa",
  TESSERA_OPERATOR_PASSWORD: "tessera-docker-qa",
  TESSERA_INTERNAL_URL: "http://tessera-server:8000",
  TESSERA_CAPTURE_UPSTREAM: "",
  TESSERA_CAPTURE_BYPASS: "",
};
// Do not inherit real-provider or scheduling overrides from the user's .env.
for (const key of [
  "PI_PROVIDER_API",
  "PI_CONTEXT_WINDOW",
  "PI_REVIEW_MODEL",
  "PI_REVIEW_BASE_URL",
  "PI_REVIEW_API_KEY",
  "PI_REVIEW_PROVIDER_API",
  "PI_REVIEW_CONTEXT_WINDOW",
  "TESSERA_MAX_WORKERS",
  "TESSERA_MAX_PROJECT_WORKERS",
  "TESSERA_MAX_PROJECT_REVIEW_WORKERS",
  "TESSERA_INTERVAL_MS",
  "TESSERA_DEBOUNCE_MS",
  "TESSERA_TASK_TIMEOUT_SECONDS",
  "TESSERA_CLOSEOUT_SECONDS",
  "TESSERA_TOOL_TIMEOUT_SECONDS",
  "TESSERA_RESULT_REPAIRS",
])
  env[key] = "";
const appImage = env.TESSERA_APP_IMAGE || "ghcr.io/kksty/tessera-server:0.3.0";
const workerImage = env.TESSERA_WORKER_IMAGE || "ghcr.io/kksty/tessera-runtime:0.3.0";
// 单账号登录门：下面所有 /api 调用都带上会话 Cookie。
let session = "";
async function login() {
  const response = await fetch("http://127.0.0.1:8788/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: env.TESSERA_OPERATOR_USER,
      password: env.TESSERA_OPERATOR_PASSWORD,
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  session = String(response.headers.get("set-cookie")).split(";")[0];
  assert.match(session, /^tessera_session=/);
}
const docker = (args) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  }).trim();
const compose = (...args) => docker(["compose", "-p", project, "-f", "compose.yaml", ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch("http://127.0.0.1:8788/api" + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { cookie: session } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? null : response.json();
}
async function wait(fn, ms = 120000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(1500);
  }
  throw new Error("Docker QA timeout");
}
(async () => {
  const ids = [];
  fs.mkdirSync(env.TESSERA_DATA_DIR, { recursive: true });
  try {
    compose("up", "-d", "--no-build", "tessera-server", "tessera-dispatcher");
    await wait(async () => {
      const r = await fetch("http://127.0.0.1:8788/health");
      return r.ok;
    });
    await login();
    docker([
      "run",
      "-d",
      "--name",
      model,
      "--network",
      network,
      "--mount",
      `type=bind,source=${resolve("tests/fixtures/mock-model.mjs")},target=/opt/tessera/mock-model.mjs,readonly`,
      appImage,
      "node",
      "mock-model.mjs",
    ]);
    const config = await api("/runtime");
    delete config.model.api_key_set;
    await api(
      "/runtime",
      {
        ...config,
        max_workers: 6,
        max_project_workers: 2,
        debounce_ms: 0,
        model: {
          id: "tessera-fixture",
          base_url: `http://${model}:9000/v1`,
          api_key: "fixture-key",
          api: "openai-completions",
          context_window: 32000,
        },
      },
      "PUT",
    );
    for (let i = 0; i < 4; i++) {
      const g = await api("/projects", {
        title: "Docker pipeline fixture " + ["normal", "late", "negative", "informational"][i],
        origin: "https://example.test",
        goal: "Verify harmless fixture execution and evidence: " + ["normal", "late", "negative", "informational"][i],
      });
      ids.push(g.project.id);
    }
    let sawPendingCompletion = false;
    await wait(async () => {
      const graphs = await Promise.all(ids.map((id) => api("/projects/" + id)));
      sawPendingCompletion ||= graphs.some((g) => g.project.pending_completion);
      return graphs.every((g) => g.project.status === "completed");
    }, 180000);
    assert.ok(sawPendingCompletion, "Delayed review must exercise durable completion intent");
    // Completed projects are normally suspended by reconciliation. Freeze that
    // lifecycle while inspecting /proc, then resume it before the next fixture.
    compose("stop", "tessera-dispatcher");
    for (const [index, id] of ids.entries()) {
      docker(["start", `${project}-worker-${id}`]);
      docker([
        "exec",
        `${project}-worker-${id}`,
        "python3",
        "-c",
        [
          "from pathlib import Path",
          "secret=b'fixture-key'",
          "for file in [Path('/var/lib/tessera-capture/config.json'), *Path('/proc').glob('[0-9]*/environ')]:",
          " try: data=file.read_bytes()",
          " except (OSError, PermissionError): continue",
          " assert secret not in data, str(file)",
        ].join("\n"),
      ]);
      const g = await api("/projects/" + id);
      assert.equal(g.findings[0].status, index === 2 ? "candidate" : "confirmed");
      assert.equal(g.findings[0].review_status, index === 2 ? "needs_evidence" : "pass");
      assert.equal(g.steps.filter((s) => s.creator === "review").length, 0);
      assert.equal(g.reviews.length, 1);
      assert.equal(g.planning_revision, g.decided_planning_revision);
      assert.equal(g.findings[0].kind, index === 3 ? "informational" : "vulnerability");
      if (index === 3) {
        assert.equal(g.findings[0].cvss, null);
        assert.equal(g.findings[0].severity, null);
        const report = await api(`/projects/${id}/reports`, {});
        assert.equal(report.material.findings.length, 0);
        assert.equal(report.material.excluded.informational, 1);
      }
      assert.ok(g.usage.length >= 4);
      assert.ok(g.usage.every((u) => u.cost === null));
      const evidence = await fetch(
        `http://127.0.0.1:8788/api/projects/${id}/evidence/${g.findings[0].evidence_ids[0]}/content`,
        { headers: { cookie: session } },
      );
      assert.match(await evidence.text(), /fixture proof/);
    }
    const library = await api("/findings");
    assert.equal(library.filter((finding) => ids.includes(finding.project_id)).length, 2);
    compose("start", "tessera-dispatcher");
    const deletionProject = await api("/projects", {
      title: "Docker autonomous deletion fixture",
      origin: "https://example.test",
      goal: "Verify autonomous deletion after evidence review",
    });
    const deletionId = deletionProject.project.id;
    ids.push(deletionId);
    await wait(async () => (await api(`/projects/${deletionId}`)).project.status === "completed");
    const deleted = await api(`/projects/${deletionId}`);
    assert.deepEqual(deleted.deleted_nodes.map((node) => node.id).sort(), ["f001", "s001", "v001"]);
    assert.equal(deleted.findings.length, 0);
    assert.equal(deleted.reviews.length, 0);
    assert.ok(!deleted.facts.some((fact) => fact.id === "f001"));
    assert.ok(!deleted.steps.some((step) => step.id === "s001"));
    const history = await api(`/projects/${deletionId}/fgs?history=true`);
    assert.equal(history.node_lifecycle_version, 1);
    assert.equal(history.findings[0].review_status, "pass", "deletion retains the original Review result");
    assert.equal(history.reviews.length, 1);
    assert.ok(history.steps.find((step) => step.id === "s001").deleted.run_id);
    const deletedFact = await api(`/projects/${deletionId}/fgs/history/f001`);
    assert.ok(deletedFact.content.includes("已保存合成测试标记"));
    assert.ok(!JSON.stringify(deleted).includes("已保存合成测试标记"));
    const deletionReport = await api(`/projects/${deletionId}/reports`, {});
    assert.equal(deletionReport.material.findings.length, 0);
    await sleep(3000);
    const workdir = await api(`/projects/${ids[0]}/workspace?path=.`);
    assert.ok(workdir.files.some((file) => file.name === "qa-proof.txt"));
    const rawFile = await fetch(`http://127.0.0.1:8788/api/projects/${ids[0]}/workspace/content?path=qa-proof.txt`, {
      headers: { cookie: session },
    });
    assert.match(await rawFile.text(), /fixture proof/);
    const denied = await fetch(
      `http://127.0.0.1:8788/api/projects/${ids[0]}/workspace/content?path=..%2Fetc%2Fpasswd`,
      { headers: { cookie: session } },
    );
    assert.equal(denied.status, 403);
    const volume = project + "-workspace-" + ids[0];
    docker(["rm", "-f", project + "-worker-" + ids[0]]);
    const proof = docker([
      "run",
      "--rm",
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      workerImage,
      "cat",
      "/workspace/qa-proof.txt",
    ]);
    assert.match(proof, /fixture proof/);
    docker([
      "run",
      "--rm",
      "--mount",
      `type=volume,source=${volume},target=/workspace`,
      workerImage,
      "node",
      "-e",
      "require('node:fs').writeFileSync('/workspace/only-one.txt','isolated')",
    ]);
    await api(`/projects/${ids[0]}/workspace`, { path: "only-one.txt" }, "DELETE");
    const deletedListing = await api(`/projects/${ids[0]}/workspace?path=.`);
    assert.ok(!deletedListing.files.some((file) => file.name === "only-one.txt"));
    docker([
      "run",
      "--rm",
      "--mount",
      `type=volume,source=${project}-workspace-${ids[1]},target=/workspace`,
      workerImage,
      "sh",
      "-c",
      "test ! -e /workspace/only-one.txt",
    ]);
    compose("restart", "tessera-server");
    await wait(async () => {
      const g = await api("/projects/" + ids[0]);
      return g.project.status === "completed";
    });
    assert.deepEqual((await api(`/projects/${deletionId}`)).deleted_nodes.map((node) => node.id).sort(), [
      "f001",
      "s001",
      "v001",
    ]);
    assert.equal((await api(`/projects/${deletionId}/fgs/history/v001`)).deletion.cascade, "downstream");
    const browser = docker([
      "run",
      "--rm",
      workerImage,
      "chromium",
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      "about:blank",
    ]);
    assert.match(browser, /<html/);
    docker([
      "run",
      "--rm",
      workerImage,
      "python3",
      "-c",
      'import pwn, pymongo, requests, bs4; print("python tools ready")',
    ]);
    console.log(
      "Docker QA passed: Compose, dispatcher, isolated project containers, actual Pi SDK + bash + evidence + review + completion, autonomous downstream deletion + explicit history + report filtering, restart persistence, durable workspaces, Chromium and Python tools.",
    );
  } catch (error) {
    try {
      console.error(compose("logs", "--tail", "30"));
      console.error(docker(["logs", "--tail", "20", model]));
      for (const id of ids) {
        try {
          console.error(JSON.stringify(await api("/projects/" + id), null, 2));
        } catch {}
      }
    } catch {}
    throw error;
  } finally {
    try {
      docker(["rm", "-f", model]);
    } catch {}
    for (const id of ids) {
      try {
        docker(["rm", "-f", project + "-worker-" + id]);
      } catch {}
      try {
        docker(["volume", "rm", project + "-workspace-" + id]);
      } catch {}
    }
    try {
      compose("down");
    } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
