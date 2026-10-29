import type { DispatchConfig, Finding } from "../../../packages/protocol/src/index.js";

/**
 * Feishu (Lark) bot notifications for operator-facing events.
 *
 * Delivery is strictly best-effort: a notification never blocks, delays or fails
 * the request that produced it. A broken webhook is logged and otherwise ignored.
 * Two event families are supported, each gated by its own switch:
 *   - a new Finding was submitted;
 *   - work now needs a human (an interrupted Run awaiting a manual retry decision,
 *     an asset awaiting approval, or a project-level error) — the same content as
 *     the project's 人工重试 page, not the review queue.
 *
 * Each notification is one interactive card: compact header + a few short fields,
 * never a wall of text. Full detail stays in the platform.
 */

type NotificationSettings = NonNullable<DispatchConfig["notifications"]>;

const FEISHU_TIMEOUT_MS = 8000;

/** Redact the bot secret embedded in a Feishu hook path before logging it. */
function maskWebhook(url: string) {
  return url.replace(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, "••••");
}

/** Collapse whitespace so multi-line error blobs never break the card layout. */
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Clamp a field to a short preview; the platform keeps the full text. */
const clip = (value: string, max: number) => {
  const text = oneLine(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

type CardField = { label: string; value: string };
interface Card {
  template: "red" | "orange" | "blue" | "grey";
  title: string;
  subtitle?: string;
  fields: CardField[];
  footer?: string;
}

/** One item that needs a human; the kind picks the leading icon in the card. */
export interface PendingItem {
  key: string;
  kind: "retry" | "assets" | "error";
  line: string;
  /** Platform timestamp for this item (e.g. the blocked Run's finish time). */
  at?: string;
}

/** Distinct leading emoji per pending-work kind, so types read apart at a glance. */
const KIND_ICON: Record<PendingItem["kind"], string> = {
  retry: "🔁",
  assets: "🛡️",
  error: "⚠️",
};

/** Format a platform ISO timestamp in the deployment's timezone (Asia/Shanghai). */
const TIME_ZONE = "Asia/Shanghai";
function formatTime(iso?: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** POST one interactive card to a Feishu bot webhook. Never throws. */
export async function postFeishu(webhook: string, card: Card): Promise<void> {
  if (!webhook) return;
  const elements: unknown[] = [];
  for (const field of card.fields) {
    elements.push({
      tag: "div",
      fields: [
        {
          is_short: false,
          text: { tag: "lark_md", content: `**${field.label}**\n${field.value || "—"}` },
        },
      ],
    });
  }
  if (card.footer) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: card.footer }] });
  const body = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: card.template,
        title: {
          tag: "plain_text",
          content: card.subtitle ? `${card.title} · ${card.subtitle}` : card.title,
        },
      },
      elements,
    },
  };
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS),
    });
    // Feishu returns HTTP 200 with a non-zero `code` on application errors.
    if (response.ok) {
      const data = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
      if (data && typeof data.code === "number" && data.code !== 0)
        console.warn(`Feishu notification rejected (${data.code}): ${data.msg ?? "unknown"} — ${maskWebhook(webhook)}`);
      return;
    }
    console.warn(`Feishu notification failed: HTTP ${response.status} — ${maskWebhook(webhook)}`);
  } catch (error) {
    console.warn(
      `Feishu notification failed: ${error instanceof Error ? error.message : String(error)} — ${maskWebhook(webhook)}`,
    );
  }
}

export class Notifier {
  /** IDs of Findings already announced, so a replayed or re-revised submit is not re-sent. */
  private announcedFindings = new Set<string>();
  /** Last known signature of the pending-work set, so we notify only on a new item. */
  private lastNeedsHuman = new Set<string>();
  /** Pending-work items collected during the aggregation window, sent as one card. */
  private pendingNeedsHuman = new Map<string, string>();
  private needsHumanTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Card[] = [];
  private draining = false;
  private readonly maxSeen = 5000;

  constructor(
    private readonly settings: () => NotificationSettings,
    /** Aggregation window for needs-human items; short in tests, ~8s in production. */
    private readonly aggregateMs = 8000,
  ) {}

  private webhook(): string {
    return this.settings().feishu_webhook?.trim() || "";
  }

  private enqueue(card: Card) {
    if (!this.webhook()) return;
    this.queue.push(card);
    void this.drain();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const card = this.queue.shift()!;
        await postFeishu(this.webhook(), card);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Announce a newly submitted Finding, once per finding id. One compact card:
   * project, title and a short description preview — the full dossier stays on
   * the platform.
   */
  notifyNewFinding(finding: Finding, projectTitle: string) {
    const settings = this.settings();
    if (!settings.notify_new_finding || !this.webhook()) return;
    if (this.announcedFindings.has(finding.id)) return;
    this.announcedFindings.add(finding.id);
    if (this.announcedFindings.size > this.maxSeen)
      this.announcedFindings = new Set(Array.from(this.announcedFindings).slice(-this.maxSeen / 2));
    const kindLabel =
      finding.kind === "informational" ? "信息类" : finding.kind === "vulnerability" ? "漏洞" : "未分类";
    const fields: CardField[] = [
      { label: "类型", value: kindLabel },
      { label: "项目", value: projectTitle },
      // The title is shown in full — never clipped — so the operator can read the
      // whole claim without opening the platform.
      { label: "标题", value: finding.title.trim() },
    ];
    if (finding.description?.trim()) fields.push({ label: "描述", value: clip(finding.description, 120) });
    fields.push({ label: "发现时间", value: formatTime(finding.created_at) });
    this.enqueue({
      template: "red",
      title: "🔎 新发现",
      fields,
      footer: `发现 ${finding.id} · 完整内容见平台`,
    });
  }

  /**
   * Establish the pending set that already existed when the process started.
   * Without this baseline a restart (or any fresh Notifier) treats every old
   * pending item as new and re-announces paused/other projects on the first
   * successful write. Priming never sends a card.
   */
  primeNeedsHuman(items: readonly PendingItem[]) {
    this.lastNeedsHuman = new Set(items.map((item) => item.key));
    this.pendingNeedsHuman.clear();
  }

  /**
   * Announce work that now needs a human — the 人工重试 content supplied by the
   * caller (interrupted Runs awaiting a manual retry decision, assets awaiting
   * approval, project errors). The signature is the set of concrete pending items;
   * a card is sent only when that set gains a new entry. New items buffer for
   * `aggregateMs` and flush as a single summary card, so a burst of changes
   * produces one card, not one per item.
   */
  notifyNeedsHuman(items: readonly PendingItem[]) {
    const settings = this.settings();
    const current = new Set(items.map((item) => item.key));
    // Keep the baseline current even while delivery is off, so turning the switch
    // (or filling the webhook) later never replays work that predates the change.
    if (!settings.notify_needs_human || !this.webhook()) {
      this.lastNeedsHuman = current;
      this.pendingNeedsHuman.clear();
      return;
    }
    for (const item of items)
      if (!this.lastNeedsHuman.has(item.key)) {
        const time = formatTime(item.at);
        this.pendingNeedsHuman.set(item.key, `${KIND_ICON[item.kind]} ${item.line}${time ? `（${time}）` : ""}`);
      }
    this.lastNeedsHuman = current;
    if (!this.pendingNeedsHuman.size || this.needsHumanTimer) return;
    this.needsHumanTimer = setTimeout(() => {
      this.needsHumanTimer = null;
      const lines = Array.from(this.pendingNeedsHuman.values());
      this.pendingNeedsHuman.clear();
      if (!lines.length) return;
      this.enqueue({
        template: "orange",
        title: "🙋 需要人工处理",
        fields: [{ label: "待处理事项", value: lines.join("\n") }],
        footer: "详见项目「人工重试」页",
      });
    }, this.aggregateMs);
    this.needsHumanTimer.unref?.();
  }
}
