import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../../packages/core/src/store.js";
import { createProjectSchema } from "../../packages/protocol/src/index.js";
import { buildApp } from "../../apps/server/src/app.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import { OperatorAuth, cookieValue, sessionCookie } from "../../apps/server/src/operator-auth.js";
import { projectToken } from "../../packages/protocol/src/internal-auth.js";

test("operator credentials are provisioned once, hashed at rest, and reload from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-"));
  try {
    const file = join(dir, "operator.json");
    const first = new OperatorAuth(file, {});
    assert.ok(first.provisionedPassword, "首次启动应生成一次性密码");
    assert.equal(first.username, "operator");
    assert.ok(first.verify("operator", first.provisionedPassword!));
    assert.ok(!first.verify("operator", "wrong"));
    assert.ok(!first.verify("someone-else", first.provisionedPassword!));
    // 文件里只有摘要与签名密钥，绝不含明文密码
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes(first.provisionedPassword!), "凭据文件不应包含明文密码");
    const second = new OperatorAuth(file, {});
    assert.equal(second.provisionedPassword, null, "已存在的凭据不应再打印密码");
    assert.ok(second.verify("operator", first.provisionedPassword!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("environment credentials win, are never written to disk, and keep sessions across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-env-"));
  try {
    const file = join(dir, "operator.json");
    const auth = new OperatorAuth(file, { user: "qa", password: "s3cret" });
    assert.equal(auth.username, "qa");
    assert.equal(auth.provisionedPassword, null);
    assert.ok(auth.verify("qa", "s3cret"));
    // 只持久化签名密钥，文件里既没有口令明文也没有摘要
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("s3cret"), "环境变量提供凭据时不应把口令落盘");
    assert.ok(!raw.includes("hash") && !raw.includes("salt"), "环境变量模式下不应写入口令材料");
    // 「重启」后旧会话仍然有效（docker-check 会真的重启容器）
    const restarted = new OperatorAuth(file, { user: "qa", password: "s3cret" });
    assert.ok(restarted.valid(auth.issue()), "重启后已签发的会话不应失效");
    // 换口令则旧会话作废
    const rotated = new OperatorAuth(join(dir, "other.json"), { user: "qa", password: "new-secret" });
    assert.ok(rotated.valid(rotated.issue()));
    assert.ok(!rotated.valid(auth.issue()), "不同签名密钥签发的会话必须被拒绝");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing the environment password invalidates sessions signed with the old password", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-rotate-"));
  try {
    const file = join(dir, "operator.json");
    const first = new OperatorAuth(file, { user: "qa", password: "old-secret" });
    const token = first.issue();
    assert.ok(first.valid(token));
    const rotated = new OperatorAuth(file, { user: "qa", password: "new-secret" });
    assert.ok(rotated.valid(rotated.issue()));
    assert.ok(!rotated.valid(token), "旧口令签发的会话必须失效");
    // 同一口令重启仍然保留会话。
    const restarted = new OperatorAuth(file, { user: "qa", password: "new-secret" });
    assert.ok(restarted.valid(rotated.issue()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions are signed, expire, and reject tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-session-"));
  try {
    const auth = new OperatorAuth(join(dir, "operator.json"), { user: "qa", password: "s3cret" });
    const token = auth.issue();
    assert.ok(auth.valid(token));
    assert.ok(!auth.valid(undefined) && !auth.valid("") && !auth.valid("nonsense"));
    // 篡改签名或把过期时间改到未来都必须失败
    const [exp, signature] = token.split(".");
    assert.ok(!auth.valid(`${exp}.${signature.slice(0, -1)}${signature.at(-1) === "A" ? "B" : "A"}`));
    assert.ok(!auth.valid(`${Number(exp) + 999999}.${signature}`), "超长有效期不应被接受");
    const past = new OperatorAuth(join(dir, "other.json"), { user: "qa", password: "s3cret" });
    assert.ok(!past.valid(`${Math.floor(Date.now() / 1000) - 10}.${signature}`), "过期会话应被拒绝");
    assert.ok(past.valid(past.issue()), "同一实例签发的会话必须有效");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login gate protects every operator route while internal worker callers keep working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-gate-"));
  const store = new Store(join(dir, "db"));
  const auth = new OperatorAuth(join(dir, "operator.json"), { user: "qa", password: "s3cret" });
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "web"), "worker-token", { auth });
  const project = store.create(
    createProjectSchema.parse({ title: "gate", origin: "https://example.test", goal: "Assess" }),
  );
  try {
    // 未登录：所有数据与操作接口都必须 401（审计里被点名的免鉴权路由在内）
    for (const call of [
      { method: "GET" as const, url: "/api/projects" },
      { method: "GET" as const, url: "/api/overview" },
      { method: "GET" as const, url: "/api/findings" },
      { method: "GET" as const, url: "/api/reviews" },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/hints`,
        payload: { content: "x", creator: "y" },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/hints/h001/resolve`,
        payload: { note: "x" },
      },
      {
        method: "DELETE" as const,
        url: `/api/projects/${project.project.id}/hints/h001/resolve`,
        payload: { note: "x" },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/reviews/r001/issues/0/waive`,
        payload: { reason: "x" },
      },
      {
        method: "DELETE" as const,
        url: `/api/projects/${project.project.id}/reviews/r001/issues/0/waive`,
      },
      {
        method: "PUT" as const,
        url: `/api/projects/${project.project.id}/goals/goal`,
        payload: { description: "新目标" },
      },
      {
        method: "PUT" as const,
        url: `/api/projects/${project.project.id}/origin`,
        payload: { description: "https://new.test" },
      },
      { method: "PUT" as const, url: `/api/projects/${project.project.id}/status`, payload: { status: "stopped" } },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/assets/approve`,
        payload: { ids: ["a001"] },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/assets`,
        payload: { assets: [{ hostname: "attacker.example" }] },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/evidence`,
        payload: { title: "t", content: "c" },
      },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/complete`,
        payload: { from: ["origin"], description: "d", worker: "w" },
      },
      { method: "PUT" as const, url: "/api/runtime", payload: {} },
      { method: "POST" as const, url: "/api/runtime/models", payload: {} },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/findings/v001/actions`,
        payload: { action: "return", expected_version: 1, creator: "x", reason: "y" },
      },
    ]) {
      const response = await app.inject(call);
      assert.equal(response.statusCode, 401, `${call.method} ${call.url} 应要求登录`);
    }
    // 会话接口本身可匿名访问，用于前端判断
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/session" })).json().authenticated, false);
    // 错误凭据
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "qa", password: "nope" },
    });
    assert.equal(bad.statusCode, 401);
    // 正确凭据 -> 拿到签名 Cookie
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "qa", password: "s3cret" },
    });
    assert.equal(login.statusCode, 200);
    const header = String(login.headers["set-cookie"]);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    const token = cookieValue(header);
    assert.ok(token && auth.valid(token));
    const cookie = sessionCookie(token!);
    const cookieHeader = cookie.split(";")[0];
    // 带 Cookie 后数据与操作接口都要放行
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: cookieHeader } })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/reviews", headers: { cookie: cookieHeader } })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${project.project.id}/status`,
          headers: { cookie: cookieHeader },
          payload: { status: "stopped" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: cookieHeader } })).json()
        .username,
      "qa",
    );
    // 内部 Worker/Dispatcher 用内部 token 旁路，不需要 Cookie；但内部 token
    // 不再等同于“操作员”：自批资产、改状态、完成项目与改部署设置必须被拒绝。
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/projects", headers: { "x-tessera-worker-token": "worker-token" } }))
        .statusCode,
      200,
    );
    for (const call of [
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/assets/approve`,
        payload: { ids: ["a001"] },
      },
      { method: "PUT" as const, url: `/api/projects/${project.project.id}/status`, payload: { status: "stopped" } },
      {
        method: "POST" as const,
        url: `/api/projects/${project.project.id}/complete`,
        payload: { from: ["origin"], description: "d", worker: "w" },
      },
      { method: "PUT" as const, url: "/api/runtime", payload: {} },
    ]) {
      const response = await app.inject({ ...call, headers: { "x-tessera-worker-token": "worker-token" } });
      assert.equal(response.statusCode, 403, `${call.method} ${call.url} 必须要求操作员 Cookie`);
    }
    // A manual (no Run) upload is an operator action, not a Worker capability.
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project.project.id}/evidence`,
          headers: { "x-tessera-worker-token": "worker-token" },
          payload: { title: "t", content: "c" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project.project.id}/evidence`,
          headers: { cookie: cookieHeader },
          payload: { title: "t", content: "c" },
        })
      ).statusCode,
      200,
    );
    // 错误 token + 无 Cookie 依然 401
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/projects", headers: { "x-tessera-worker-token": "wrong" } }))
        .statusCode,
      401,
    );
    // 登出后清掉 Cookie
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookieHeader } });
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: "" } })).statusCode, 401);
    // 健康检查不属于 /api，必须保持公开（Docker healthcheck 依赖它）
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally {
    await app.close();
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project capability cannot read or claim work in another project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-project-token-"));
  const store = new Store(join(dir, "db"));
  const auth = new OperatorAuth(join(dir, "operator.json"), { user: "qa", password: "s3cret" });
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "web"), "worker-token", { auth });
  const a = store.create(createProjectSchema.parse({ title: "A", origin: "https://a.test", goal: "Assess" }));
  const b = store.create(createProjectSchema.parse({ title: "B", origin: "https://b.test", goal: "Assess" }));
  const tokenA = projectToken("worker-token", a.project.id);
  const headers = { "x-tessera-project-token": tokenA };
  try {
    assert.equal((await app.inject({ url: `/api/projects/${a.project.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/projects/${b.project.id}`, headers })).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${b.project.id}/fgs/search`,
          headers,
          payload: { keyword: "secret" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${b.project.id}/jobs/claim`,
          headers,
          payload: { worker: "w" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: "/api/projects", headers })).statusCode,
      403,
      "a project capability cannot enumerate every project",
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated failures lock the login endpoint briefly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-lock-"));
  const store = new Store(join(dir, "db"));
  const auth = new OperatorAuth(join(dir, "operator.json"), { user: "qa", password: "s3cret" });
  const app = buildApp(store, new RuntimeConfig(join(dir, "config.json")), join(dir, "web"), "worker-token", { auth });
  try {
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal(
        (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "qa", password: "wrong" } }))
          .statusCode,
        401,
      );
    // 第 6 次即使密码正确也应被暂时挡住
    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "qa", password: "s3cret" },
    });
    assert.equal(locked.statusCode, 429);
    assert.match(locked.json().detail, /秒后再试/);
    assert.ok(auth.lockedMs() > 0);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
