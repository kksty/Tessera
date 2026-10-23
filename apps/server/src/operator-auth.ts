import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 单账号操作员凭据。这不是多租户：只有一个用户名，所有登录者看到同一批项目。
 *  凭据优先级：环境变量（TESSERA_OPERATOR_USER/PASSWORD）> 持久化文件 > 首次启动自动生成。
 *  自动生成时把明文交给调用方打印一次（`docker logs`），文件里只留 scrypt 摘要与签名密钥。 */
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOCK_AFTER = 5;
const LOCK_MS = 30_000;

interface Stored {
  version: 1;
  username: string;
  salt: string;
  hash: string;
  secret: string;
}

const digest = (password: string, salt: string) => scryptSync(password, salt, 64);
const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export class OperatorAuth {
  private stored: Stored;
  private failures = 0;
  private lockedUntil = 0;
  /** 仅首次自动生成时非空：调用方需要把它打印一次给操作员。 */
  readonly provisionedPassword: string | null;

  constructor(
    private file: string,
    env: { user?: string; password?: string } = {},
  ) {
    const user = env.user?.trim();
    const password = env.password;
    const saved = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>)
      : undefined;
    // 签名密钥必须跨重启稳定：否则每次重启都会静默把所有人登出。
    // 环境变量模式下只持久化随机基底，绝不落任何口令材料；会话密钥由
    // 基底与当前口令派生，换口令即让旧 Cookie 全部失效。
    const base = saved?.secret || randomBytes(32).toString("hex");
    const rotate = (purpose: string) => createHmac("sha256", base).update(purpose).digest("hex");
    if (user && password) {
      const salt = randomBytes(16).toString("hex");
      this.stored = { version: 1, username: user, salt, hash: encode(digest(password, salt)),
        secret: rotate(`env\0${user}\0${password}`) };
      if (!saved?.secret) this.save({ version: 1, secret: base });
      this.provisionedPassword = null;
      return;
    }
    if (saved?.username && saved?.salt && saved?.hash && saved?.secret) {
      this.stored = saved as Stored;
      this.provisionedPassword = null;
      return;
    }
    const generated = randomBytes(12).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    this.stored = {
      version: 1,
      username: user || "operator",
      salt,
      hash: encode(digest(generated, salt)),
      // A removed environment credential must not leave old sessions valid.
      secret: rotate(`generated\0${generated}`),
    };
    this.save(this.stored);
    this.provisionedPassword = generated;
  }

  private save(value: Stored | { version: 1; secret: string }) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  get username() {
    return this.stored.username;
  }

  /** 失败次数过多时短暂锁定，避免把登录接口当成离线爆破入口。 */
  lockedMs() {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  verify(username: string, password: string) {
    if (this.lockedMs() > 0) return false;
    const candidate = Buffer.from(encode(digest(password, this.stored.salt)));
    const expected = Buffer.from(this.stored.hash);
    // timingSafeEqual 要求等长：先比长度再比内容（长度本身不是秘密）。
    const suppliedUser = Buffer.from(username);
    const expectedUser = Buffer.from(this.stored.username);
    const sameUser = suppliedUser.length === expectedUser.length && timingSafeEqual(suppliedUser, expectedUser);
    const samePassword = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (sameUser && samePassword) {
      this.failures = 0;
      return true;
    }
    if (++this.failures >= LOCK_AFTER) {
      this.failures = 0;
      this.lockedUntil = Date.now() + LOCK_MS;
    }
    return false;
  }

  /** 无状态签名会话：`<exp>.<hmac>`。登出只清 Cookie（单账号场景无需服务端会话表）。 */
  issue(now = Date.now()) {
    const exp = Math.floor(now / 1000) + SESSION_SECONDS;
    return `${exp}.${this.sign(String(exp))}`;
  }

  valid(token: string | undefined | null) {
    if (!token) return false;
    const [exp, signature] = token.split(".");
    if (!exp || !signature || !/^\d{1,12}$/.test(exp)) return false;
    const expected = Buffer.from(this.sign(exp));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    const seconds = Number(exp);
    // 允许 60 秒时钟偏移；上限防止签名密钥泄漏后被签发无限期会话。
    return seconds > Date.now() / 1000 && seconds <= Date.now() / 1000 + SESSION_SECONDS + 60;
  }

  private sign(value: string) {
    return createHmac("sha256", this.stored.secret).update(value).digest("base64url");
  }
}

export const SESSION_COOKIE = "tessera_session";
export const SESSION_MAX_AGE = SESSION_SECONDS;

/** 凭据文件默认与内部 token 同放数据目录，随数据卷一起持久化。 */
export const operatorAuthFile = (evidenceRoot: string) =>
  process.env.TESSERA_AUTH_FILE || join(dirname(evidenceRoot), "operator.json");

export function cookieValue(header: string | undefined, name = SESSION_COOKIE): string | undefined {
  for (const part of (header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure = false) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
