export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // 会话过期或被登出：通知外壳回到登录页，而不是把 401 当成普通业务错误。
    if (response.status === 401) window.dispatchEvent(new Event("tessera:unauthorized"));
    let message = response.statusText;
    try {
      message = (await response.json()).detail || message;
    } catch {}
    throw new ApiError(response.status, message);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const path = (id: string, suffix = "") => `/projects/${encodeURIComponent(id)}${suffix}`;

/** Upload one binary body (project bundle ZIP) without JSON encoding it. */
export async function apiUpload<T>(endpoint: string, file: Blob): Promise<T> {
  const response = await fetch("/api" + endpoint, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: file,
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("tessera:unauthorized"));
    let message = response.statusText;
    try {
      message = (await response.json()).detail || message;
    } catch {}
    throw new ApiError(response.status, message);
  }
  return response.json();
}
