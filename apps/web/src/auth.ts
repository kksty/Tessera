/** 单账号登录的前端封装。会话是 HttpOnly 签名 Cookie，前端只关心"是否已登录"。 */
export interface Session {
  authenticated: boolean;
  username?: string;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch {}
    throw new Error(detail || "请求失败");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const authSession = () => request<Session>("/auth/session");
export const authLogin = (username: string, password: string) =>
  request<Session>("/auth/login", { username, password });
export const authLogout = () => request<Session>("/auth/logout", {});
