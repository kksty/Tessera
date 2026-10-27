import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../../apps/web/src/components/RichText.js";
import { isMarkdownEvidence, looksLikeMarkdownDocument } from "../../apps/web/src/markdown.js";

test("markdown evidence is declared by mime type or source path", () => {
  assert.equal(isMarkdownEvidence({ mime_type: "text/markdown" }), true);
  assert.equal(isMarkdownEvidence({ mime_type: "text/x-markdown; charset=utf-8" }), true);
  assert.equal(isMarkdownEvidence({ mime_type: "text/plain", source_path: "notes/report.md" }), true);
  assert.equal(
    isMarkdownEvidence({ mime_type: "text/plain", source_path: "/workspace/evidence/s016/summary.MD" }),
    true,
  );
  // 显式 .md 即使只有一级标题也不靠正文猜。
  assert.equal(isMarkdownEvidence({ source_path: "evidence/summary.md" }, "# 只有标题"), true);
});

test("markdown written into .txt or process logs is detected by its document skeleton", () => {
  const summary = [
    "# s016 聚合统计结果",
    "",
    "统计方法见 scripts/s016_aggregate.py。",
    "",
    "## 用例计数",
    "",
    "- 实际请求次数：40",
    "- 有响应：28",
    "",
    "## 状态码",
    "",
    "- 200 × 3",
  ].join("\n");
  assert.equal(looksLikeMarkdownDocument(summary), true);
  assert.equal(
    isMarkdownEvidence({ mime_type: "text/plain", source_path: "/workspace/evidence/s016/summary.txt" }, summary),
    true,
  );

  const transcript = [
    "# s003 收尾复测 transcript",
    "# 对照: / -> 200, /zzz -> 404",
    "",
    "## 逐条结果（路径 code size）",
    "/robots.txt\t404\t196",
    "/healthz\t200\t30",
  ].join("\n");
  assert.equal(looksLikeMarkdownDocument(transcript), true);
});

test("raw evidence is not reshaped even when its text contains #/* markers", () => {
  const cases = [
    // curl verbose：`* Host` 行不是列表。
    "* Host example.test:443 was resolved.\n* IPv6: (none)\n* Trying 1.2.3.4:443...\n",
    // 一级 `#` 注释组成的字典/摘要。
    "# 一级子路径枚举小字典\n# 来源: 前端代码\n\nadmin/login\nadmin/logout\n",
    // nmap 的 `#` 起止注释。
    "# Nmap 7.991 scan initiated Fri Oct 23 23:45:34 2026\nNmap scan report for example.test\n22/tcp open ssh\n# Nmap done\n",
    // 只有一级 `###` 分节的 HTTP 记录。
    "### 请求: GET /admin\n### curl: curl -sk https://example.test/admin\n\nHTTP/1.1 200 OK\n",
  ];
  for (const text of cases) assert.equal(looksLikeMarkdownDocument(text), false, text.split("\n")[0]);

  assert.equal(isMarkdownEvidence({ mime_type: "text/plain" }, '{"note":"# 标题\\n\\n## 分节"}'), false);
  assert.equal(isMarkdownEvidence({ mime_type: "text/plain" }, "#!/bin/bash\n\n# 运行\n\n## 用法\n\n- a\n"), false);
  assert.equal(isMarkdownEvidence({ mime_type: "text/plain", source_path: "logs/run.log" }, "plain\n"), false);
});

test("markdown evidence renders headings, lists, tables and fenced code as markup", () => {
  const text = [
    "# 结论",
    "",
    "### 步骤",
    "",
    "- 第一项",
    "- **重点** 与 `code`",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    "| status | 200 |",
    "",
    "```",
    "GET / HTTP/1.1",
    "```",
    "",
    "<script>alert(1)</script>",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(RichText, { text }));
  assert.match(html, /<h3>.*结论.*<\/h3>/);
  assert.match(html, /<h4>.*步骤.*<\/h4>/);
  assert.match(html, /<li>.*第一项.*<\/li>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<th>.*字段.*<\/th>/);
  assert.match(html, /<pre><code>GET \/ HTTP\/1\.1<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("evidence rendering keeps source line breaks inside unmarked paragraphs", () => {
  const html = renderToStaticMarkup(
    createElement(RichText, { text: "# 标题\n\n第一行\n第二行\n  第三行", preserveLines: true }),
  );
  assert.match(html, /class="rich-text rich-text-lines"/);
  assert.ok(html.includes("第一行\n第二行\n  第三行"));
  // 审核、发现等正文仍按普通段落排版。
  const plain = renderToStaticMarkup(createElement(RichText, { text: "# 标题\n\n第一行\n第二行" }));
  assert.doesNotMatch(plain, /rich-text-lines/);
});
