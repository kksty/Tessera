# 测试项目 · 安全评估报告

报告编号：report\_fixture
生成时间：2026-10-20T06:00:00.000Z
输入摘要（SHA-256）：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## 目标与范围

目标：核查记录访问边界

起点：https://example.test


## 结果概览

本报告包含 1 项当前版本已通过审核的漏洞。
未纳入正文：1 项待确认或待补证据，2 项已驳回，3 项非漏洞信息类。
风险分布：严重 1 · 高 0 · 中 0 · 低 0 · 信息 0 · 未定级 0

风险等级未知时保持未知；无发现不等同于不存在漏洞。

## v001 · 跨账号记录读取

版本：3；风险：严重
CVSS v4.0：9.3 · CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N

使用测试账号访问记录。 响应包含另一账号的数据。

### 风险依据

响应证明记录访问边界被绕过。

CVSS 评分依据：Unauthenticated high-impact issue

复审前危险度（仅作历史标记）：高；最终危险度：严重

### 实际影响

原始响应证明测试账号越权读取另一账号的受保护记录。

### 复现条件

- 准备测试账号

### 复现步骤

1. 登录测试账号

**2. 请求**

```http
GET /records/2 HTTP/1.1
Host: example.test
```

3. 检查响应中的所有者

正常预期：拒绝跨账号访问

实际观测：返回另一账号的记录

### 修复建议

在记录读取入口校验当前账号对记录的所有权，并补充跨账号访问回归用例。

### 身份与证据

```json
{
  "category": "access_control",
  "host": "example.test",
  "path": "/records",
  "parameter": "id"
}
```

来源事实：未记录
证据：e001

```text
GET /records/2 HTTP/1.1
Host: example.test

HTTP/1.1 200 OK
{"owner":"other"}
```

审核 r001：独立核对已归档的响应
审核证据：e001

## 原始证据索引

- e001：原始响应；123 字节；text/plain；SHA-256：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

本报告为固定内容快照；后续 Finding、审核、范围或证据引用变更后，旧快照会标记过期。
