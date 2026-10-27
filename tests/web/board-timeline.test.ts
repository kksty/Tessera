import { test } from "node:test";
import assert from "node:assert/strict";
import { boardTimelineText } from "../../apps/web/src/board-timeline.js";
import type { Event } from "../../packages/protocol/src/index.js";

const event = (kind: string, changes: Record<string, unknown>): Event => ({
  seq: 1,
  revision: 12,
  project_id: "p1",
  kind,
  data: { changes },
  created_at: "2026-10-27T02:00:00.000Z",
});

test("黑板时间线用中文动作和节点摘要，不把内部 ID 当标题", () => {
  const text = boardTimelineText(
    event("fact.observed", {
      facts: [{ id: "f001", description: "很长的原始命令输出", conclusion: "服务分布：443 为 Apache" }],
    }),
  );
  assert.equal(text.title, "新增观测");
  assert.equal(text.detail, "服务分布：443 为 Apache");
  assert.doesNotMatch(`${text.title}${text.detail}`, /f001|fact\./);
});

test("修改提示不会误用同批任务描述作为摘要", () => {
  const text = boardTimelineText(
    event("hint.updated", {
      steps: [{ id: "s001", description: "顺带调整的任务" }],
      project: { id: "p1", title: "项目" },
    }),
  );
  assert.equal(text.title, "修改提示");
  assert.equal(text.detail, "");
});

test("项目状态使用中文动作", () => {
  assert.equal(
    boardTimelineText(event("project.status", { project: { id: "p1", status: "stopped" } })).title,
    "暂停项目",
  );
  assert.equal(
    boardTimelineText(event("project.status", { project: { id: "p1", status: "completed" } })).title,
    "项目完成",
  );
});
