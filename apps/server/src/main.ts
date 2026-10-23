import { Store } from "../../../packages/core/src/store.js";
import { buildApp } from "./app.js";
import { RuntimeConfig } from "./runtime.js";
import { OperatorAuth, operatorAuthFile } from "./operator-auth.js";
const file = process.env.TESSERA_DB || ".tessera/tessera.db";
const store = new Store(file, Number(process.env.TESSERA_LEASE_SECONDS) || 120);
const runtime = new RuntimeConfig(
  process.env.TESSERA_CONFIG || ".tessera/runtime.json",
);
// 首次启动自动生成单账号凭据：只在标准输出打印一次，文件里只留 scrypt 摘要。
const auth = new OperatorAuth(operatorAuthFile(store.evidenceRoot), {
  user: process.env.TESSERA_OPERATOR_USER,
  password: process.env.TESSERA_OPERATOR_PASSWORD,
});
if (auth.provisionedPassword)
  console.log(`Tessera 已生成登录凭据（只显示这一次）：用户名 ${auth.username} 密码 ${auth.provisionedPassword}\n如需自定义，请设置 TESSERA_OPERATOR_USER 与 TESSERA_OPERATOR_PASSWORD 后重启。`);
const app = buildApp(store, runtime, undefined, undefined, { auth });
await app.listen({
  host: process.env.TESSERA_HOST || "0.0.0.0",
  port: Number(process.env.TESSERA_PORT) || 8000,
});
console.log(`Tessera http://127.0.0.1:${Number(process.env.TESSERA_PORT) || 8000}`);
const maintenance = setInterval(() => { try { store.maintenance(); } catch(error) { console.error("Storage maintenance failed", error); } }, 300000);
maintenance.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(maintenance);
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
