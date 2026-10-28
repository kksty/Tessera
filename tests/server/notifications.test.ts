import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifier } from "../../apps/server/src/notifications.js";
import { RuntimeConfig } from "../../apps/server/src/runtime.js";
import type { Finding } from "../../packages/protocol/src/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tessera-notify-"));
  return {
    dir,
    file: join(dir, "runtime.json"),
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Flatten every string in a parsed Feishu payload into one searchable blob. */
function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flatten(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => flatten(item, out));
  return out;
}

/** A throwaway local HTTP server that records every card it receives. */
async function hookReceiver() {
  const cards: string[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        cards.push(flatten(JSON.parse(data)).join("\n"));
      } catch {
        // Ignore malformed probes.
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url,
    cards,
    async waitFor(count: number) {
      for (let i = 0; i < 100 && cards.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const finding = (overrides: Partial<Finding> = {}): Finding =>
  ({
    id: "v001",
    graph_id: "main",
    title: "Reflected XSS",
    description: "The search box reflects user input",
    severity: "high",
    kind: "vulnerability",
    status: "candidate",
    review_status: "pending",
    version: 1,
    from: [],
    evidence_ids: [],
    created_at: new Date().toISOString(),
    ...overrides,
  }) as Finding;

test("new finding card carries only a compact title and description preview", async () => {
  const receiver = await hookReceiver();
  try {
    let settings = { feishu_webhook: receiver.url, notify_new_finding: true, notify_needs_human: false };
    const notifier = new Notifier(() => settings, 20);
    notifier.notifyNewFinding(
      finding({
        description: `${"长描述 ".repeat(120)}`.trim(), // far beyond the 120-char preview
        impact: "可读取任意用户会话",
        remediation: "对 cookie 使用 HttpOnly",
      }),
      "示例项目",
    );
    // The same finding id must never announce twice (replay / revision).
    notifier.notifyNewFinding(finding(), "示例项目");
    await receiver.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(receiver.cards.length, 1);
    const card = receiver.cards[0];
    assert.match(card, /🔎 新发现/);
    assert.match(card, /\*\*类型\*\*\n漏洞/);
    assert.match(card, /\*\*项目\*\*\n示例项目/);
    assert.match(card, /\*\*标题\*\*\nReflected XSS/);
    assert.match(card, /\*\*描述\*\*\n/);
    // Discovery time on the platform is shown on the card.
    assert.match(card, /\*\*发现时间\*\*\n\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
    // The description is clipped to a short preview ending in an ellipsis, not the
    // full 480-char dossier: the truncated text is present but the full text is not.
    const full = "长描述 ".repeat(120).trim();
    assert.match(card, /长描述 长描述 .*…/);
    assert.ok(!card.includes(full), "the full description must not be sent");
    // Other dossier fields never leave the platform.
    assert.doesNotMatch(card, /可读取任意用户会话/);
    assert.doesNotMatch(card, /HttpOnly/);
    // Switch off: nothing further is sent.
    settings = { ...settings, notify_new_finding: false };
    notifier.notifyNewFinding(finding({ id: "v002" }), "示例项目");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receiver.cards.length, 1);
    // Switch back on: a distinct finding id is delivered again.
    settings = { ...settings, notify_new_finding: true };
    notifier.notifyNewFinding(finding({ id: "v002" }), "示例项目");
    await receiver.waitFor(2);
    assert.equal(receiver.cards.length, 2);
    // A long title is delivered in full, never clipped.
    const longTitle =
      "采购明细 AJAX 接口无分页钳制：匿名单次请求即可拉取全量公示数据（rows 无上限、page 被忽略），卡片完整显示";
    notifier.notifyNewFinding(finding({ id: "v003", title: longTitle }), "示例项目");
    await receiver.waitFor(3);
    assert.match(receiver.cards[2], new RegExp(`\\*\\*标题\\*\\*\\n${longTitle}`));
  } finally {
    await receiver.close();
  }
});

test("needs-human card aggregates newly pending work and never repeats it", async () => {
  const receiver = await hookReceiver();
  try {
    let settings = { feishu_webhook: receiver.url, notify_new_finding: false, notify_needs_human: true };
    const notifier = new Notifier(() => settings, 20);
    const retry = {
      key: "p1:retry",
      kind: "retry" as const,
      line: "示例项目：2 次运行待人工重试",
      at: "2026-10-28T02:03:04.000Z",
    };
    notifier.notifyNeedsHuman([retry]);
    // A second, different pending item inside the window joins the same card.
    notifier.notifyNeedsHuman([retry, { key: "p2:assets", kind: "assets", line: "另一个项目：3 个资产等待人工批准" }]);
    await receiver.waitFor(1);
    assert.equal(receiver.cards.length, 1);
    assert.match(receiver.cards[0], /🙋 需要人工处理/);
    // Distinct leading icon per kind: retry vs. asset approval, with platform time.
    assert.match(receiver.cards[0], /🔁 示例项目：2 次运行待人工重试（2026\/10\/28 10:03:04）/);
    assert.match(receiver.cards[0], /🛡️ 另一个项目：3 个资产等待人工批准/);
    // Recomputing the same pending set must not re-send.
    notifier.notifyNeedsHuman([retry, { key: "p2:assets", kind: "assets", line: "另一个项目：3 个资产等待人工批准" }]);
    notifier.notifyNeedsHuman([retry]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receiver.cards.length, 1);
    // After the window flushed, a newly appearing item is a new card.
    notifier.notifyNeedsHuman([retry, { key: "p3:error", kind: "error", line: "出错项目：项目错误 — boom" }]);
    await receiver.waitFor(2);
    assert.equal(receiver.cards.length, 2);
    assert.match(receiver.cards[1], /⚠️ 出错项目：项目错误 — boom/);
    // Switch off: nothing further.
    settings = { ...settings, notify_needs_human: false };
    notifier.notifyNeedsHuman([{ key: "p4:retry", kind: "retry", line: "新项目：1 次运行待人工重试" }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receiver.cards.length, 2);
  } finally {
    await receiver.close();
  }
});

test("an empty webhook disables all delivery without throwing", async () => {
  const notifier = new Notifier(() => ({ feishu_webhook: "", notify_new_finding: true, notify_needs_human: true }));
  assert.doesNotThrow(() => notifier.notifyNewFinding(finding(), "t"));
  assert.doesNotThrow(() => notifier.notifyNeedsHuman([{ key: "p1:retry", kind: "retry", line: "x" }]));
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("notification config persists, redacts the webhook, and keeps it across empty submits", async () => {
  const f = fixture();
  const hook = "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000";
  try {
    const config = new RuntimeConfig(f.file, {});
    // No webhook by default (tests/fresh installs never deliver); switches start on
    // so filling the webhook in Settings is the only step needed.
    assert.equal(config.value.notifications!.feishu_webhook, "");
    assert.equal(config.value.notifications!.notify_new_finding, true);
    assert.equal(config.value.notifications!.notify_needs_human, true);
    assert.equal(config.redacted().notifications.feishu_webhook_set, false);
    // Saving a webhook persists it but redaction masks the value.
    config.updatePublic({ notifications: { feishu_webhook: hook } });
    assert.equal(new RuntimeConfig(f.file, {}).value.notifications!.feishu_webhook, hook);
    const redacted = config.redacted();
    assert.equal(redacted.notifications.feishu_webhook, "");
    assert.equal(redacted.notifications.feishu_webhook_set, true);
    // An empty webhook submit keeps the stored secret; "-" clears it.
    config.updatePublic({ notifications: { feishu_webhook: "", notify_new_finding: false } });
    assert.equal(new RuntimeConfig(f.file, {}).value.notifications!.feishu_webhook, hook);
    assert.equal(new RuntimeConfig(f.file, {}).value.notifications!.notify_new_finding, false);
    config.updatePublic({ notifications: { feishu_webhook: "-" } });
    assert.equal(new RuntimeConfig(f.file, {}).value.notifications!.feishu_webhook, "");
    assert.equal(config.redacted().notifications.feishu_webhook_set, false);
    // A non-HTTPS webhook is rejected.
    assert.throws(
      () => config.updatePublic({ notifications: { feishu_webhook: "http://example.test/hook" } }),
      /HTTPS/,
    );
    // Env overrides lock the switches.
    const env = new RuntimeConfig(f.file, {
      TESSERA_NOTIFY_NEW_FINDING: "0",
      TESSERA_NOTIFY_NEEDS_HUMAN: "1",
    });
    assert.equal(env.value.notifications!.notify_new_finding, false);
    assert.equal(env.value.notifications!.notify_needs_human, true);
    assert.ok(env.readOnlyFields.includes("notifications.notify_new_finding"));
  } finally {
    f.close();
  }
});
