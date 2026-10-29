import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolEnvironment } from "./tool-environment.js";

/**
 * Named HTTP authentication profiles for Execute/Peer Runs.
 *
 * The test account and its cookie jar must survive across Steps and Runs, but
 * they are credentials, not Evidence: profiles and jars live under
 * `<workspace>/auth` and never become graph nodes. Requests run through the
 * worker's curl so the existing proxy/TLS environment and cookie-jar semantics
 * apply; cookie values are never returned to the model, only names and scopes.
 */

const PROFILE_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Profile = {
  name: string;
  base_url: string;
  headers?: Record<string, string>;
  notes?: string;
  created_at: string;
  updated_at: string;
};

type CookieSummary = { name: string; domain: string; path: string; secure: boolean; expires: number | null };

function writePrivate(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600 });
}

function readProfile(profiles: string, name: string): Profile {
  const file = join(profiles, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Unknown auth profile: ${name}`);
  return JSON.parse(readFileSync(file, "utf8")) as Profile;
}

function publicProfile(profile: Profile, cookies: CookieSummary[]) {
  return {
    name: profile.name,
    base_url: profile.base_url,
    header_names: Object.keys(profile.headers ?? {}),
    notes: profile.notes,
    updated_at: profile.updated_at,
    cookies: cookies.map(({ name, domain, path, secure, expires }) => ({ name, domain, path, secure, expires })),
  };
}

function parseCookieJar(text: string): CookieSummary[] {
  const cookies: CookieSummary[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [rawDomain, , path, secure, expires, name] = fields;
    const domain = rawDomain.replace(/^#HttpOnly_/, "");
    const expiry = Number(expires);
    cookies.push({
      name,
      domain,
      path,
      secure: secure.toUpperCase() === "TRUE",
      expires: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
    });
  }
  return cookies;
}

function cookiesAt(jar: string): CookieSummary[] {
  return existsSync(jar) ? parseCookieJar(readFileSync(jar, "utf8")) : [];
}

function writeCookieJar(
  jar: string,
  base: URL,
  cookies: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    expires?: number;
    http_only?: boolean;
  }[],
) {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const cookie of cookies) {
    if (!cookie.name || /[\t\r\n]/.test(cookie.name)) throw new Error("Cookie names must be non-empty and single-line");
    if (/[\t\r\n]/.test(cookie.value)) throw new Error("Cookie values must be single-line");
    const domain = (cookie.domain || base.hostname).replace(/^\./, "");
    const path = cookie.path || "/";
    const secure = cookie.secure ?? base.protocol === "https:";
    const expires = Number.isFinite(cookie.expires) && (cookie.expires ?? 0) > 0 ? Math.floor(cookie.expires!) : 0;
    lines.push(
      `${cookie.http_only ? "#HttpOnly_" : ""}${domain}\tTRUE\t${path}\t${secure ? "TRUE" : "FALSE"}\t${expires}\t${cookie.name}\t${cookie.value}`,
    );
  }
  writePrivate(jar, lines.join("\n") + "\n");
  return parseCookieJar(readFileSync(jar, "utf8"));
}

function requestHeaders(
  profile: Profile,
  extra: Record<string, string> | undefined,
  body: string | undefined,
  contentType: string | undefined,
) {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(profile.headers ?? {})) headers.set(name, value);
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  if (![...headers.keys()].some((name) => name.toLowerCase() === "user-agent")) headers.set("User-Agent", DEFAULT_UA);
  if (body !== undefined && ![...headers.keys()].some((name) => name.toLowerCase() === "content-type"))
    headers.set("Content-Type", contentType || "application/x-www-form-urlencoded");
  return headers;
}

function parseHeaderBlock(text: string) {
  const blocks = text.split(/\r?\n\r?\n/).filter(Boolean);
  const block = blocks.at(-1) ?? "";
  const lines = block.split(/\r?\n/);
  const status = Number((lines.shift() || "").match(/^HTTP\/[\d.]+\s+(\d{3})/)?.[1] ?? 0);
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name.toLowerCase() === "set-cookie") setCookies.push(value);
    else if (headers[name.toLowerCase()] === undefined) headers[name.toLowerCase()] = value;
  }
  return { status, headers, setCookies };
}

function runCurl(args: string[], signal: AbortSignal | undefined, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn("curl", args, {
      env: toolEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`curl timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64 * 1024) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16 * 1024) stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function approvedUrl(url: URL, approvedHosts: Set<string>) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("Auth requests require an http(s) URL");
  if (approvedHosts.size && !approvedHosts.has(url.hostname.toLowerCase()))
    throw new Error(`Host ${url.hostname} is not an approved asset`);
}

export function authProfileTools(workspace: string, approvedHosts: Set<string> = new Set()): ToolDefinition[] {
  const root = join(workspace, "auth");
  const profiles = join(root, "profiles");
  const jars = join(root, "jars");
  const temp = join(root, "tmp");
  for (const dir of [root, profiles, jars, temp]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });

  return [
    {
      name: "auth_profile",
      label: "auth_profile",
      description:
        "Manage named authenticated HTTP profiles for this project. Profiles and cookie jars persist under /workspace/auth across Steps and Runs but are not Evidence. " +
        "save a profile with base_url, then request with a registration or login body and capture_cookies=true, then request authenticated endpoints. " +
        "For JS/RSA/CA/Playwright logins that the tool cannot replay, use set_cookies with the browser's cookies, then request. " +
        "Cookie values are never returned; only names/domains. Use one profile per account/role. Never put passwords in notes; request bodies are omitted from diagnostics.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("save"),
          Type.Literal("list"),
          Type.Literal("request"),
          Type.Literal("set_cookies"),
          Type.Literal("cookies"),
          Type.Literal("clear"),
          Type.Literal("delete"),
        ]),
        name: Type.Optional(Type.String()),
        base_url: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        notes: Type.Optional(Type.String()),
        method: Type.Optional(Type.Union(METHODS.map((method) => Type.Literal(method)))),
        path: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        content_type: Type.Optional(Type.String()),
        cookies: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              value: Type.String(),
              domain: Type.Optional(Type.String()),
              path: Type.Optional(Type.String()),
              secure: Type.Optional(Type.Boolean()),
              expires: Type.Optional(Type.Number()),
              http_only: Type.Optional(Type.Boolean()),
            }),
          ),
        ),
      }),
      execute: async (_id, raw, signal) => {
        const args = raw as {
          action: "save" | "list" | "request" | "set_cookies" | "cookies" | "clear" | "delete";
          name?: string;
          base_url?: string;
          headers?: Record<string, string>;
          notes?: string;
          method?: (typeof METHODS)[number];
          path?: string;
          body?: string;
          content_type?: string;
          cookies?: {
            name: string;
            value: string;
            domain?: string;
            path?: string;
            secure?: boolean;
            expires?: number;
            http_only?: boolean;
          }[];
          capture_cookies?: boolean;
          follow_redirects?: boolean;
          max_bytes?: number;
        };
        if (args.action === "list") {
          const items = readdirSync(profiles)
            .filter((file) => file.endsWith(".json"))
            .map((file) => {
              const name = file.slice(0, -5);
              try {
                return publicProfile(readProfile(profiles, name), cookiesAt(join(jars, `${name}.cookies`)));
              } catch {
                return { name, error: "profile is unreadable" };
              }
            });
          return result({ profiles: items });
        }
        const name = args.name?.trim() ?? "";
        if (!PROFILE_NAME.test(name)) throw new Error("name must be 1-40 characters of letters, digits, '-' or '_'");
        const profileFile = join(profiles, `${name}.json`);
        const jar = join(jars, `${name}.cookies`);

        if (args.action === "save") {
          if (!args.base_url) throw new Error("base_url is required for save");
          const base = new URL(args.base_url);
          approvedUrl(base, approvedHosts);
          if (
            args.headers &&
            Object.keys(args.headers).some((key) => ["cookie", "set-cookie"].includes(key.toLowerCase()))
          )
            throw new Error("Do not put Cookie/Set-Cookie in headers; the tool keeps the cookie jar");
          const previous = existsSync(profileFile) ? readProfile(profiles, name) : undefined;
          const now = new Date().toISOString();
          const profile: Profile = {
            name,
            base_url: base.toString(),
            headers: args.headers,
            notes: args.notes?.slice(0, 1000),
            created_at: previous?.created_at ?? now,
            updated_at: now,
          };
          writePrivate(profileFile, JSON.stringify(profile, null, 2));
          return result({ profile: publicProfile(profile, cookiesAt(jar)) });
        }
        if (args.action === "set_cookies") {
          const profile = readProfile(profiles, name);
          if (!args.cookies?.length) throw new Error("cookies must contain at least one cookie");
          const cookies = writeCookieJar(jar, new URL(profile.base_url), args.cookies);
          return result({ name, cookies });
        }
        if (args.action === "cookies") {
          readProfile(profiles, name);
          return result({ name, cookies: cookiesAt(jar) });
        }
        if (args.action === "clear") {
          readProfile(profiles, name);
          if (existsSync(jar)) rmSync(jar, { force: true });
          return result({ name, cookies: [] });
        }
        if (args.action === "delete") {
          if (existsSync(profileFile)) rmSync(profileFile, { force: true });
          if (existsSync(jar)) rmSync(jar, { force: true });
          return result({ name, deleted: true });
        }

        // request
        const profile = readProfile(profiles, name);
        const base = new URL(profile.base_url);
        const url = new URL(args.path ?? "", base);
        if (url.origin !== base.origin)
          throw new Error("Auth requests must stay on the profile's origin; save a separate profile for another asset");
        approvedUrl(url, approvedHosts);
        const method = args.method ?? "GET";
        const capture = args.capture_cookies !== false;
        const follow = args.follow_redirects !== false;
        const headers = requestHeaders(profile, args.headers, args.body, args.content_type);
        if ([...headers.keys()].some((key) => key.toLowerCase() === "cookie"))
          throw new Error("Do not set Cookie manually; the tool uses the profile's cookie jar");
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const headersFile = join(temp, `${id}.headers`);
        const bodyFile = join(temp, `${id}.body`);
        const requestFile = join(temp, `${id}.request`);
        writePrivate(requestFile, args.body ?? "");
        const curlArgs = [
          "-sS",
          "--max-time",
          "60",
          "--max-redirs",
          "5",
          "-D",
          headersFile,
          "-o",
          bodyFile,
          "-w",
          "%{http_code}\n%{url_effective}",
          "-b",
          jar,
          ...(capture ? ["-c", jar] : []),
          ...(follow ? ["-L"] : []),
          "-X",
          method,
        ];
        for (const [key, value] of headers) curlArgs.push("-H", `${key}: ${value}`);
        if (args.body !== undefined) curlArgs.push("--data-binary", `@${requestFile}`);
        curlArgs.push(url.toString());
        try {
          const { stdout, stderr, code } = await runCurl(curlArgs, signal, 70_000);
          const [statusLine, finalUrl = url.toString()] = stdout.trim().split("\n");
          const status = Number(statusLine);
          if (!Number.isFinite(status) || status <= 0) {
            return result({ name, error: stderr.trim().slice(0, 1500) || `curl exited with ${code}` });
          }
          const headerText = existsSync(headersFile) ? readFileSync(headersFile, "utf8") : "";
          const parsed = parseHeaderBlock(headerText);
          const maxBytes = args.max_bytes ?? 20_000;
          const rawBody = existsSync(bodyFile) ? readFileSync(bodyFile) : Buffer.alloc(0);
          const truncated = rawBody.length > maxBytes;
          const body = rawBody.subarray(0, maxBytes).toString("utf8");
          const cookies = cookiesAt(jar);
          const final = new URL(finalUrl);
          return result({
            name,
            method,
            request_url: url.toString(),
            status,
            final_url: finalUrl,
            cross_origin_redirect: final.origin !== base.origin,
            header_names: Object.keys(parsed.headers),
            content_type: parsed.headers["content-type"],
            location: parsed.headers.location,
            set_cookie_count: parsed.setCookies.length,
            body_bytes: rawBody.length,
            truncated,
            body,
            cookies: cookies.map(({ name, domain, path, secure, expires }) => ({
              name,
              domain,
              path,
              secure,
              expires,
            })),
          });
        } finally {
          for (const file of [headersFile, bodyFile, requestFile]) {
            try {
              if (existsSync(file)) rmSync(file, { force: true });
            } catch {}
          }
        }
      },
    },
  ];
}

/** Keep request bodies and header values out of diagnostic tool_start excerpts. */
export function authProfileExcerpt(args: unknown) {
  if (!args || typeof args !== "object") return args;
  const value = args as Record<string, unknown>;
  return {
    action: value.action,
    name: value.name,
    base_url: value.base_url,
    method: value.method,
    path: value.path,
    body: value.body === undefined ? undefined : "[omitted]",
    header_names: value.headers && typeof value.headers === "object" ? Object.keys(value.headers) : undefined,
    cookie_names: Array.isArray(value.cookies)
      ? value.cookies
          .map((cookie) => (cookie && typeof cookie === "object" ? (cookie as { name?: unknown }).name : undefined))
          .filter((name) => typeof name === "string")
      : undefined,
    capture_cookies: value.capture_cookies,
    follow_redirects: value.follow_redirects,
    max_bytes: value.max_bytes,
  };
}
