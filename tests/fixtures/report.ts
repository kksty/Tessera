import type { ReportSnapshot } from "../../packages/core/src/reports.js";
import { scoreCvss } from "../../packages/core/src/cvss.js";
import { cvss } from "./cvss.js";

/** Complete report content for protocol tests whose subject is a passing review. */
export const reportFields = {
  impact: "原始响应证明测试账号越权读取另一账号的受保护记录。",
  reproduction: {
    conditions: ["准备测试账号及另一账号的记录编号"],
    steps: ["使用测试账号请求另一账号的记录，核对响应中的记录所有者。"],
    expected: "拒绝访问其他账号的记录", observed: "返回其他账号的记录",
  },
  remediation: "在记录读取入口校验当前账号对记录的所有权，并补充跨账号访问回归用例。",
};

export function reportSnapshot(empty = false): ReportSnapshot {
  const at = "2026-10-20T06:00:00.000Z";
  return {
    id: "report_fixture", project_id: "project_fixture", created_at: at, source_hash: "a".repeat(64), format_version: 1,
    material: {
      project: { id: "project_fixture", title: "测试项目", },
      origin: "https://example.test", goal: "核查记录访问边界", scope: [],
      findings: empty ? [] : [{ ...structuredClone(reportFields),
        id: "v001", title: "跨账号记录读取", kind: "vulnerability", description: "使用测试账号访问记录。\n响应包含另一账号的数据。",
        version: 3, reviewed_version: 3, status: "confirmed", review_status: "pass", created_at: at, graph_id: "main",
        severity: "critical", severity_before_review: "high", severity_reason: "响应证明记录访问边界被绕过。",
        cvss: scoreCvss(cvss.critical), evidence_ids: ["e001"], from: [],
        evidence: "GET /records/2 HTTP/1.1\r\nHost: example.test\r\n\r\nHTTP/1.1 200 OK\r\n{\"owner\":\"other\"}",
        identity: { category: "access_control", host: "example.test", path: "/records", parameter: "id" },
        reproduction: { conditions: ["准备测试账号"], steps: ["1. 登录测试账号", "2. GET /records/2 HTTP/1.1", "Host: example.test", "3. 检查响应中的所有者"], expected: "拒绝跨账号访问", observed: "返回另一账号的记录" },
      }],
      reviews: empty ? [] : [{ id: "r001", finding_id: "v001", finding_version: 3, kind: "vulnerability", verdict: "pass", reason: "独立核对已归档的响应", evidence_ids: ["e001"], disputed_fact_ids: [], created_at: at, worker: "reviewer" }],
      facts: [], evidence: empty ? [] : [{ id: "e001", title: "原始响应", mime_type: "text/plain", size: 123, sha256: "b".repeat(64), created_at: at }],
      excluded: { pending: 1, rejected: 2, informational: 3 },
      trace: { relations: [], steps: [] },
    },
  };
}
