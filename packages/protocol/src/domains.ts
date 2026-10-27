/**
 * 测试域的固定枚举与中文说法。
 *
 * 单独成模块（不依赖 zod）：前端汇总、节点详情和日志导出都要用它，
 * 而网页侧只需要常量，不应该为此把整套 Schema 打进首屏包。
 */
export const TEST_DOMAINS = [
  "recon",
  "entry",
  "auth",
  "access",
  "inject",
  "file",
  "config",
  "logic",
  "post",
  "other",
] as const;

export type TestDomain = (typeof TEST_DOMAINS)[number];

/** 测试域的中文说法：黑板汇总、节点详情、日志导出共用同一份口径。 */
export const TEST_DOMAIN_LABELS: Record<TestDomain, string> = {
  recon: "资产与暴露面",
  entry: "入口与前端",
  auth: "认证与会话",
  access: "授权与访问控制",
  inject: "输入与注入",
  file: "文件与上传",
  config: "配置与传输",
  logic: "业务逻辑",
  post: "后渗透与影响",
  other: "其他 / 未分类",
};
