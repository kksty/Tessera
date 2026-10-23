import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportContent } from "../../apps/web/src/components/ReportPreview.js";
import { Store } from "../../packages/core/src/store.js";
import { Reports } from "../../packages/core/src/reports.js";
import { reportView } from "../../packages/core/src/report-view.js";
import { paragraph } from "../../packages/core/src/report-text.js";
import { reportSnapshot } from "../fixtures/report.js";

const htmlText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("web and Markdown render the same report fields, scores, identity and request text", () => {
  const store = new Store(":memory:");
  try {
    const snapshot = reportSnapshot(), v = reportView(snapshot.material), f = v.findings[0];
    const html = renderToStaticMarkup(createElement(ReportContent, { report: snapshot, stale: false }));
    const text = htmlText(html), markdown = new Reports(store).markdown(snapshot);
    const fields = [v.header.goal, v.header.origin, f.title, f.description, f.impact, f.severityReason, f.remediation,
      f.expected, f.observed, ...f.conditions, f.cvss!.label, f.cvss!.rationale, f.reviews[0].reason,
      snapshot.material.evidence[0].sha256];
    for (const value of fields) {
      assert.ok(text.includes(value), `web is missing ${value}`);
      assert.ok(markdown.includes(paragraph(value)), `Markdown is missing ${value}`);
    }
    for (const value of [f.identity!, f.evidence!.replace(/\r\n/g, "\n"), ...f.reproBlocks.map(block => block.text)]) {
      assert.ok(text.replace(/\r\n/g, "\n").includes(value), `web is missing literal ${value}`);
      assert.ok(markdown.includes(value), `Markdown is missing literal ${value}`);
    }
    assert.ok(text.includes(snapshot.id)); assert.ok(markdown.includes("report\\_fixture"));
    assert.ok(text.includes(snapshot.source_hash));
    assert.match(html, /<pre class="report-code"><code>/);
    assert.match(text, /复审前危险度（仅作历史标记）：高；最终危险度：严重/);
  } finally { store.close(); }
});

test("both formats share empty and missing-field messages and CVSS ordering without mutation", () => {
  const store = new Store(":memory:");
  try {
    const reports = new Reports(store);
    const empty = reportSnapshot(true), message = reportView(empty.material).summary.empty;
    assert.ok(reports.markdown(empty).includes(message));
    assert.ok(htmlText(renderToStaticMarkup(createElement(ReportContent, { report: empty, stale: false }))).includes(message));
    const snapshot = reportSnapshot(), lower = structuredClone(snapshot.material.findings[0]);
    lower.id = "v002"; lower.cvss = null; lower.severity = null;
    lower.impact = null; lower.remediation = null; lower.reproduction = null;
    snapshot.material.findings.unshift(lower);
    const before = structuredClone(snapshot), v = reportView(snapshot.material);
    assert.deepEqual(v.findings.map(f => f.id), ["v001", "v002"]);
    for (const output of [reports.markdown(snapshot), htmlText(renderToStaticMarkup(createElement(ReportContent, { report: snapshot, stale: false })))]) {
      assert.ok(output.indexOf("v001 ·") < output.indexOf("v002 ·"));
      assert.ok(output.includes("缺少：影响描述 / 复现步骤 / 修复建议"));
      assert.ok(output.includes("1 项字段不全")); assert.ok(output.includes("未定级"));
    }
    assert.deepEqual(snapshot, before);
  } finally { store.close(); }
});

test("web preview escapes injected text and renders evidence as literal code", () => {
  const snapshot = reportSnapshot(), injected = '<script>alert(1)</script>\n\n## 伪造章节\n\n[x](javascript:alert(1))';
  Object.assign(snapshot.material.findings[0], { title: injected, description: injected, impact: injected, remediation: injected, evidence: injected });
  snapshot.material.evidence[0].title = injected;
  const html = renderToStaticMarkup(createElement(ReportContent, { report: snapshot, stale: false }));
  assert.doesNotMatch(html, /<script>|href="javascript:|<h\d>伪造章节/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(htmlText(html).includes(injected));
});
