import type { Review, ReviewIssueWaiver } from "./models.js";

/**
 * Planning issues about authorization or personal data are treated as high risk.
 * The classification is deliberately conservative: a false positive only asks a
 * human to acknowledge the dismissal, while a false negative would let Decide
 * bury the issue that matters most. Keyword matching is intentionally bilingual
 * because Review reasons and issue text are free-form.
 */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\bidor\b/i,
  /insecure\s+direct\s+object/i,
  /broken\s+(?:object|access\s+control)/i,
  /access\s+control/i,
  /authori[sz]ation\s+(?:bypass|check|missing|flaw|weak)/i,
  /privilege\s+escalation/i,
  /account\s+takeover/i,
  /越权/,
  /(?:未|未经)授权/,
  /权限(?:校验|控制|提升|绕过|缺失|不当)/,
  /访问控制/,
  /认证绕过/,
  /提权/,
  /(?:他人|其他用户|其他账号|其他账户|别人)/,
  /任意(?:用户|账号|账户)/,
  /跨(?:用户|账号|账户|租户)/,
  /cross[- ](?:account|tenant|user)/i,
  /租户隔离/,
  /\bpii\b/i,
  /personally\s+identifiable/i,
  /personal\s+(?:data|information)/i,
  /个人(?:信息|隐私|数据|资料)/,
  /隐私/,
  /身份证|手机号|住址|银行卡/,
  /敏感(?:信息|数据|字段|资料)/,
  /sensitive\s+(?:personal\s+)?(?:data|information)/i,
  /数据泄露|信息泄露/,
  /data\s+(?:leak|exposure|disclosure)/i,
  /exfiltrat/i,
];

export type ReviewIssueRisk = "high" | "normal";

export function reviewIssueRisk(issue: string): ReviewIssueRisk {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(issue)) ? "high" : "normal";
}

/** The human waiver that closes this issue, if the operator recorded one. */
export function reviewIssueWaiver(review: Review, index: number): ReviewIssueWaiver | undefined {
  return review.issue_waivers?.find((waiver) => waiver.index === index);
}
