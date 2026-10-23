import { useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound, Loader2, Lock, User } from "lucide-react";
import { brand } from "../brand";
import { authLogin, type Session } from "../auth";
import { LogoLockup } from "./Logo";

/** 单账号登录页。没有多租户：登录后看到的就是全部项目。 */
export function LoginPage({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onSuccess(await authLogin(username.trim(), password));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "登录失败");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <section className="login-brand-panel">
        <div className="login-brand-top">
          <LogoLockup />
          <span className="login-version">单账号工作区</span>
        </div>
        <div className="login-brand-copy">
          <h1>
            把每一次观察
            <br />
            拼成可回查的证据。
          </h1>
          <p>
            {brand.name} 是模型驱动的自主安全测试工作台：探索路径、候选结论与原始证据都留在一张图里，
            跨项目风险在同一个总览中收敛。
          </p>
          <ul className="login-points">
            <li>
              <span className="point-index">01</span>
              <div>
                <strong>探索成图</strong>
                <small>事实、任务与结论以因果链相连，随时回放。</small>
              </div>
            </li>
            <li>
              <span className="point-index">02</span>
              <div>
                <strong>证据成链</strong>
                <small>每个结论都能回到原始请求、响应与归档材料。</small>
              </div>
            </li>
            <li>
              <span className="point-index">03</span>
              <div>
                <strong>风险收敛</strong>
                <small>所有项目的漏洞按等级、审核与处置状态统一汇总。</small>
              </div>
            </li>
          </ul>
        </div>
        <footer className="login-brand-foot">
          <span>本地部署</span>
          <span className="dot-sep" aria-hidden="true" />
          <span>数据不出工作区</span>
        </footer>
      </section>

      <section className="login-form-panel">
        <form className="login-card" onSubmit={submit}>
          <header className="login-card-head">
            <span className="eyebrow">OPERATOR SIGN IN</span>
            <h2>登录工作区</h2>
            <p>使用部署时生成的操作员凭据。</p>
          </header>

          <label className="field">
            <span className="field-label">用户名</span>
            <span className="input-with-icon">
              <User size={15} aria-hidden="true" />
              <input
                ref={usernameRef}
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="operator"
                required
              />
            </span>
          </label>

          <label className="field">
            <span className="field-label">密码</span>
            <span className="input-with-icon">
              <KeyRound size={15} aria-hidden="true" />
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
            </span>
          </label>

          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}

          <button className="button primary login-submit" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={15} aria-hidden="true" /> : null}
            <span>{busy ? "正在验证…" : "进入工作区"}</span>
            {!busy && <ArrowRight size={15} aria-hidden="true" />}
          </button>

          <div className="login-note">
            <Lock size={13} aria-hidden="true" />
            <p>
              首次启动的用户名与密码打印在服务端日志（<code>docker logs</code>），也可通过{" "}
              <code>TESSERA_OPERATOR_USER</code> / <code>TESSERA_OPERATOR_PASSWORD</code> 指定。
            </p>
          </div>
        </form>
      </section>
    </div>
  );
}
