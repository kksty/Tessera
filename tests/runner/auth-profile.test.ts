import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authProfileTools } from "../../packages/runner/src/auth-profile.js";

test("auth_profile captures cookies, reuses them and never returns cookie values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-"));
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ""}`);
      if (req.method === "POST" && req.url === "/register") {
        if (body !== "user=demo&pass=secret") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end('{"ok":false}');
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "sid=demo-token; Path=/; HttpOnly",
        });
        return res.end('{"ok":true,"user":"demo"}');
      }
      if (req.method === "GET" && req.url === "/me") {
        if (req.headers.cookie?.includes("sid=demo-token")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end('{"user":"demo","role":"tester"}');
        }
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"login required"}');
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const [auth] = authProfileTools(dir) as any[];
  try {
    const saved = JSON.parse(
      (await auth.execute("", { action: "save", name: "demo", base_url: base })).content[0].text,
    );
    assert.equal(saved.profile.name, "demo");

    const registered = JSON.parse(
      (
        await auth.execute("", {
          action: "request",
          name: "demo",
          method: "POST",
          path: "/register",
          body: "user=demo&pass=secret",
          capture_cookies: true,
        })
      ).content[0].text,
    );
    assert.equal(registered.status, 200);
    assert.equal(registered.set_cookie_count, 1);
    assert.equal(
      registered.cookies.some((cookie: any) => cookie.name === "sid"),
      true,
    );
    assert.equal(JSON.stringify(registered).includes("demo-token"), false, "cookie value must stay in the jar");

    const me = JSON.parse(
      (await auth.execute("", { action: "request", name: "demo", method: "GET", path: "/me" })).content[0].text,
    );
    assert.equal(me.status, 200);
    assert.match(me.body, /"role":"tester"/);
    assert.match(calls.at(-1) ?? "", /sid=demo-token/);

    const cookies = JSON.parse((await auth.execute("", { action: "cookies", name: "demo" })).content[0].text);
    assert.equal(cookies.cookies.length, 1);
    assert.equal(cookies.cookies[0].name, "sid");

    const listed = JSON.parse((await auth.execute("", { action: "list" })).content[0].text);
    assert.equal(listed.profiles.length, 1);
    assert.equal(listed.profiles[0].name, "demo");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth_profile imports browser cookies and uses them without echoing their values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-"));
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/me" && req.headers.cookie?.includes("sid=demo-token")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"user":"browser"}');
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"login required"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const [auth] = authProfileTools(dir) as any[];
  try {
    await auth.execute("", { action: "save", name: "browser", base_url: base });
    const imported = JSON.parse(
      (
        await auth.execute("", {
          action: "set_cookies",
          name: "browser",
          cookies: [{ name: "sid", value: "demo-token", domain: "127.0.0.1", path: "/" }],
        })
      ).content[0].text,
    );
    assert.equal(imported.cookies.length, 1);
    assert.equal(imported.cookies[0].name, "sid");
    assert.equal(JSON.stringify(imported).includes("demo-token"), false);
    const me = JSON.parse(
      (await auth.execute("", { action: "request", name: "browser", method: "GET", path: "/me" })).content[0].text,
    );
    assert.equal(me.status, 200);
    assert.match(me.body, /"user":"browser"/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth_profile refuses a host outside the approved assets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-"));
  try {
    const [auth] = authProfileTools(dir, new Set(["allowed.example"])) as any[];
    await assert.rejects(
      () => auth.execute("", { action: "save", name: "evil", base_url: "https://evil.example" }),
      /not an approved asset/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth_profile refuses cross-origin requests on an existing profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tessera-auth-"));
  try {
    const [auth] = authProfileTools(dir) as any[];
    await auth.execute("", { action: "save", name: "demo", base_url: "https://example.test" });
    await assert.rejects(
      () => auth.execute("", { action: "request", name: "demo", path: "https://other.test/me" }),
      /stay on the profile's origin/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
