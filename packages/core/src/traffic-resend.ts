import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TrafficResendResult } from "../../protocol/src/traffic.js";
import { fail } from "./errors.js";
import type { TrafficRecords } from "./traffic.js";

const MAX_REQUEST_BODY = 32 * 1024 * 1024;
const MAX_EDITED_REQUEST = 8 * 1024 * 1024;
const MAX_RESULT_BODY = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const RESEND_TIMEOUT_MS = 30_000;
// Connection-scoped headers are recomputed for this connection. Content-Length is
// recomputed from the stored body so a stale value can never truncate or hang it.
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "proxy-authorization",
]);

type StoredHeaders = [string, string][];
type Outcome = {
  status: number | null;
  head: string | null;
  body: Buffer;
  truncated: boolean;
  duration: number;
  protocol: string;
  error?: string;
};

function storedHeaders(head: string): StoredHeaders {
  const headers: StoredHeaders = [];
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return headers;
}

function preparedHeaders(headers: StoredHeaders, fallbackHost: string, body: Buffer): StoredHeaders {
  const prepared = headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()));
  if (!prepared.some(([name]) => name.toLowerCase() === "host")) prepared.unshift(["Host", fallbackHost]);
  prepared.push(["Connection", "close"]);
  if (body.length) prepared.push(["Content-Length", String(body.length)]);
  return prepared;
}

/**
 * Parse an operator-edited raw request. The destination origin stays the stored
 * flow's origin: only the method, path, headers and body can change. This keeps
 * replay on the authorized asset instead of turning it into an arbitrary SSRF
 * primitive.
 */
function editedRequest(raw: string): { method: string; target: string; headers: StoredHeaders; body: Buffer } {
  if (Buffer.byteLength(raw, "utf8") > MAX_EDITED_REQUEST) fail(413, "编辑后的请求超过 8 MiB");
  const separator = /\r?\n\r?\n/.exec(raw);
  const headText = separator ? raw.slice(0, separator.index) : raw.replace(/[\r\n]+$/, "");
  const bodyText = separator ? raw.slice(separator.index + separator[0].length) : "";
  const lines = headText.split(/\r?\n/);
  const requestLine = (lines.shift() || "").trimEnd();
  const match = /^(\S+) (\S+) (HTTP\/\d(?:\.\d)?)$/.exec(requestLine);
  if (!match) return fail(422, "请求行格式无效，应为：METHOD /path HTTP/1.1");
  const method = match[1];
  const target = match[2];
  if (method.length > 32 || !/^[A-Za-z0-9!#$%&'*+\-.^_|~]+$/.test(method)) fail(422, "请求方法包含非法字符");
  if (target.length > 16 * 1024) fail(422, "请求路径超过 16 KiB");
  if (target !== "*" && !target.startsWith("/")) fail(422, "只能修改请求路径；目标主机和端口保持原始记录");
  if (target !== "*" && /[\s\x00-\x1f\x7f]/.test(target)) fail(422, "请求路径包含控制字符或空格");
  if (target.includes("#")) fail(422, "请求路径不能包含 # 片段");

  const headers: StoredHeaders = [];
  let headerBytes = Buffer.byteLength(requestLine, "utf8");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) fail(422, "请求头之间不能有空行");
    headerBytes += Buffer.byteLength(line, "utf8") + 2;
    if (headerBytes > MAX_HEADER_BYTES) fail(413, "请求头超过 64 KiB");
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!name || !/^[A-Za-z0-9!#$%&'*+\-.^_|~]+$/.test(name)) fail(422, "请求头格式无效");
    const value = line.slice(colon + 1).trim();
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) fail(422, "请求头值包含控制字符");
    if (name.toLowerCase() === "host" && !value) fail(422, "Host 请求头不能为空");
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.push([name, value]);
  }
  if (headers.length > 200) fail(422, "请求头数量超过 200");
  if (headers.filter(([name]) => name.toLowerCase() === "host").length > 1) fail(422, "请求头不能包含重复的 Host");
  const body = Buffer.from(bodyText, "utf8");
  if (body.length > MAX_REQUEST_BODY) fail(413, "请求正文超过 32 MiB");
  return { method, target, headers, body };
}

function headerObject(headers: StoredHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const previous = result[key];
    if (previous === undefined) result[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else result[key] = [previous, value];
  }
  return result;
}

function requestHead(method: string, path: string, headers: StoredHeaders): string {
  return [`${method} ${path} HTTP/1.1`, ...headers.map(([name, value]) => `${name}: ${value}`)].join("\r\n");
}

function responseHead(version: string, status: number, reason: string, rawHeaders: string[]): string {
  const lines = [`HTTP/${version} ${status} ${reason}`.trimEnd()];
  for (let index = 0; index < rawHeaders.length; index += 2)
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1] ?? ""}`);
  return lines.join("\r\n");
}

function send(url: URL, method: string, path: string, headers: StoredHeaders, body: Buffer): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let requestRef: ClientRequest | undefined;
    const finish = (outcome: Omit<Outcome, "duration">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, duration: Date.now() - started });
    };
    const timer = setTimeout(() => {
      requestRef?.destroy(new Error("重发请求超时（30 秒）"));
      finish({
        status: null,
        head: null,
        body: Buffer.alloc(0),
        truncated: false,
        protocol: "HTTP/1.1",
        error: "重发请求超时（30 秒）",
      });
    }, RESEND_TIMEOUT_MS);
    timer.unref?.();
    try {
      const options = {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path,
        method,
        headers: headerObject(headers),
        // A replay is an explicit one-shot external action, never a pooled retry.
        agent: false,
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (response) => {
        const status = response.statusCode ?? 0;
        const head = responseHead(response.httpVersion, status, response.statusMessage || "", response.rawHeaders);
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          const remaining = MAX_RESULT_BODY - total;
          if (remaining > 0) {
            const kept = chunk.subarray(0, remaining);
            chunks.push(kept);
            total += kept.length;
          }
          if (chunk.length > remaining) truncated = true;
        });
        response.on("end", () =>
          finish({
            status: status || null,
            head,
            body: Buffer.concat(chunks),
            truncated,
            protocol: `HTTP/${response.httpVersion}`,
          }),
        );
        response.on("error", (error: Error) =>
          finish({
            status: status || null,
            head,
            body: Buffer.concat(chunks),
            truncated,
            protocol: `HTTP/${response.httpVersion}`,
            error: error.message,
          }),
        );
        response.on("aborted", () =>
          finish({
            status: status || null,
            head,
            body: Buffer.concat(chunks),
            truncated,
            protocol: `HTTP/${response.httpVersion}`,
            error: "响应在读取完成前被中断",
          }),
        );
      });
      requestRef = request;
      request.on("error", (error: Error) =>
        finish({
          status: null,
          head: null,
          body: Buffer.alloc(0),
          truncated: false,
          protocol: "HTTP/1.1",
          error: error.message,
        }),
      );
      if (body.length) request.write(body);
      request.end();
    } catch (error) {
      finish({
        status: null,
        head: null,
        body: Buffer.alloc(0),
        truncated: false,
        protocol: "HTTP/1.1",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Operator-triggered replay of one captured HTTP request. The request is sent
 * from the server and the actual response is returned to the caller only. The
 * replay is intentionally NOT archived: repeated resends would flood traffic
 * storage, so the original flow remains the single durable record. Redirects
 * are not followed. An operator may supply an edited raw request; its origin is
 * still forced to the captured flow's origin so replay cannot change targets.
 */
export async function resendTraffic(
  traffic: TrafficRecords,
  projectId: string,
  flowId: string,
  edited?: string,
): Promise<TrafficResendResult> {
  const source = traffic.get(projectId, flowId) || fail(404, "Traffic record not found");
  if ((source.capture_kind ?? "http") !== "http") fail(422, "仅 HTTP/HTTPS 流量可以重发");
  if (!edited && source.request.truncated) fail(422, "请求正文保存不完整，不能可靠重发");

  const url = (() => {
    try {
      return new URL(source.url);
    } catch {
      return fail(422, "流量 URL 无法解析，不能重发");
    }
  })();
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(422, "仅支持 HTTP/HTTPS 目标");

  const draft = edited === undefined ? null : editedRequest(edited);
  const requestBody = draft
    ? draft.body
    : (() => {
        try {
          return traffic.messageBody(projectId, source.request);
        } catch {
          return fail(422, "请求正文文件缺失，不能重发");
        }
      })();
  if (requestBody.length > MAX_REQUEST_BODY) fail(413, "请求正文超过 32 MiB，不能重发");

  const method = draft?.method ?? source.method;
  const path = draft?.target ?? `${url.pathname || "/"}${url.search}`;
  const headers = preparedHeaders(draft?.headers ?? storedHeaders(source.request.head), url.host, requestBody);
  const head = requestHead(method, path, headers);
  const outcome = await send(url, method, path, headers, requestBody);
  const resultUrl = path === "*" ? source.url : `${url.origin}${path}`;

  return {
    method,
    url: resultUrl,
    request_head: head,
    status: outcome.status,
    protocol: outcome.protocol,
    response_head: outcome.head,
    body_base64: outcome.body.toString("base64"),
    body_size: outcome.body.length,
    truncated: outcome.truncated,
    duration_ms: outcome.duration,
    ...(outcome.error ? { error: outcome.error.slice(0, 4000) } : {}),
  };
}
