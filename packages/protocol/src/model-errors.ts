export interface ModelIssue {
  kind: "quota" | "auth" | "rate_limit" | "context" | "configuration" | "unavailable" | "guard" | "response";
  title: string;
  message: string;
  action: string;
  retryable: boolean;
  status?: number;
}

/**
 * Some gateways put a content-policy interception in the assistant content with
 * HTTP 200. It is not a job result and repeating the same prompt rarely helps,
 * but the exact text is useful to the operator, so recognize only the gateway's
 * own envelope rather than any security-testing discussion of a WAF.
 */
export function guardMessage(raw?: string): string | undefined {
  if (!raw) return undefined;
  // Match the gateway's own marker, or a warning-prefixed refusal. A normal job
  // result may quote a target's WAF text ("已被安全网关拦截"), so the generic
  // phrase alone is not enough: the text must not be a JSON payload and the
  // warning glyph/marker must be at the start.
  const source = raw.trim();
  if (source.startsWith("{")) return undefined;
  const match =
    /\[此消息为llm-guard回复\]/i.exec(source) ??
    /^[\s⚠️]*[^\n]{0,120}(?:已被安全网关拦截|llm-guard[^\n]{0,60}(?:拦截|blocked)|blocked by (?:the )?(?:llm-)?guard)/i.exec(
      source,
    );
  if (!match) return undefined;
  return source
    .slice(0, Math.min(source.length, 360))
    .replace(/^[\s⚠️]*/, "")
    .trim();
}

export class ModelGuardError extends Error {
  constructor(readonly guard: string) {
    super(`Model provider failure: 安全网关拦截：${guard}`);
    this.name = "ModelGuardError";
  }
}

export function redactModelError(raw: string, secrets: string[] = []) {
  let text = raw.replace(/Bearer\s+[\w.\-/+=]+/gi, "Bearer [redacted]");
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text
    .replace(/Bearer\s+[\w.\-/+=]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key["'\s]*[:=]["'\s]*)[^\s,"'&}]+/gi, "$1[redacted]");
}

export function modelIssue(raw?: string): ModelIssue | null {
  if (!raw || !/Model provider failure:|Context (?:capacity|pressure)/i.test(raw)) return null;
  const status = Number(raw.match(/Model provider failure:\s*(\d{3})\b/)?.[1]) || undefined;
  let message = raw.replace(/^Model provider failure:\s*(?:\d{3}:?\s*)?/, "");
  try {
    const body = JSON.parse(message.slice(message.indexOf("{")));
    message = body.error?.message || body.message || body.detail || message;
  } catch {}
  const result = (kind: ModelIssue["kind"], title: string, action: string, retryable: boolean): ModelIssue => ({
    kind,
    title,
    action,
    retryable,
    status,
    message: redactModelError(String(message)).slice(0, 1500),
  });
  if (guardMessage(raw))
    return result(
      "guard",
      "模型安全网关拦截",
      "模型服务商的安全网关拦截了本次请求或回答；检查网关内容策略，或更换模型后继续项目。",
      true,
    );
  if (
    status === 402 ||
    /insufficient[_ -](?:balance|quota)|余额不足|用量上限|额度.*(?:耗尽|不足)|credit.*(?:exhaust|balance)/i.test(raw)
  )
    return result("quota", "模型额度不足", "检查服务商余额或用量额度，或更换模型配置后继续项目。", false);
  if (status === 401 || status === 403 || /invalid[_ -]api[_ -]key|authentication_error/i.test(raw))
    return result("auth", "模型鉴权失败", "检查 API Key、接口地址及模型访问权限，保存设置后继续项目。", false);
  if (/context.*(?:length|limit|window|exceed|capacity|pressure)|maximum.*token|上下文.*(?:超|限)/i.test(raw))
    return result(
      "context",
      "上下文预算不足",
      "在设置中核对 Pi 识别的供应商和实际窗口；中转请填写实际上下文与输出上限，再检测 API。已提交的观测保留。",
      false,
    );
  if (status === 404 || /model[_ -]not[_ -]found|unsupported.*(?:model|api)|invalid.*model/i.test(raw))
    return result("configuration", "模型配置不可用", "核对模型名称、API 地址和接口协议，保存设置后继续项目。", false);
  if (status === 429 || /rate[_ -]limit|too many requests/i.test(raw))
    return result("rate_limit", "模型请求被限流", "系统会退避重试；连续失败后暂停。可降低并发或更换模型。", true);
  if ((status && status >= 500) || /timeout|timed out|fetch failed|ECONN|network|socket|overloaded/i.test(raw))
    return result("unavailable", "模型服务暂时不可用", "系统会退避重试；连续失败后暂停。检查网络或服务商状态。", true);
  return result("response", "模型响应异常", "系统会有限重试；持续失败时检查接口协议、模型配置及服务商响应。", true);
}
