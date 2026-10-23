import { buildApp as productionApp } from "../../apps/server/src/app.js";
export const testWorkerToken = "tessera-fixture-worker-token";
export function buildApp(...args: Parameters<typeof productionApp>) {
  args[3] = testWorkerToken;
  // 登录门单独在 tests/server/auth.test.ts 里验证；其余用例直接以内部身份访问，避免给每个请求加 Cookie。
  args[4] = { ...args[4], auth: false };
  return productionApp(...args);
}
