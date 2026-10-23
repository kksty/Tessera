import { lazy, Suspense, useEffect, useState } from "react";
import { authSession, type Session } from "./auth.js";
import { brand } from "./brand.js";
import { LoginPage } from "./components/LoginPage.js";
import { LogoMark } from "./components/Logo.js";
import { CompatibilityNotice } from "./components/CompatibilityNotice.js";

const WorkspaceApp = lazy(() => import("./App.js").then(({ App }) => ({ default: App })));

function BootScreen() {
  return (
    <div className="boot-screen" data-loading="true" role="status" aria-label="正在加载工作区">
      <div className="boot-mark" aria-hidden="true"><LogoMark mono /></div>
      <span className="boot-name">{brand.name}</span>
    </div>
  );
}

/** Resolve the session before downloading the workspace and its page modules. */
export function AppRoot() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const receive = (next: Session) => { if (active) setSession(next); };
    void authSession().then(receive).catch(() => {
      if (!active) return;
      retry = setTimeout(() => {
        void authSession().then(receive).catch(() => receive({ authenticated: false }));
      }, 600);
    });
    return () => { active = false; clearTimeout(retry); };
  }, []);

  if (session === null) return <BootScreen />;
  if (!session.authenticated) return <LoginPage onSuccess={setSession} />;
  return (
    <>
    <CompatibilityNotice />
    <Suspense fallback={<BootScreen />}>
      <WorkspaceApp session={session} setSession={setSession} />
    </Suspense>
    </>
  );
}
