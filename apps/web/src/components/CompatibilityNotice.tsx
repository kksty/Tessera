import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api.js";

interface Compatibility {
  incompatible: number;
  requeued: number;
}

const DISMISS_KEY = "tessera.compatibility.dismissed";

/** 关闭提示只覆盖当前这批问题：数量增加（新的旧格式项目或新的待复核发现）时重新出现。 */
function readDismissed(): Compatibility | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Compatibility>;
    if (typeof value.incompatible !== "number" || typeof value.requeued !== "number") return null;
    return { incompatible: value.incompatible, requeued: value.requeued };
  } catch {
    return null;
  }
}

export function CompatibilityNotice() {
  const [state, setState] = useState<Compatibility | null>(null);
  const [dismissed, setDismissed] = useState<Compatibility | null>(readDismissed);
  useEffect(() => {
    let active = true;
    const load = () => {
      void api<Compatibility>("/runtime/compatibility")
        .then((value) => {
          if (active) setState(value);
        })
        .catch(() => {});
    };
    load();
    // 审核结束或重新审核会改变计数；工作区刷新后让提示跟着消失，而不是停在旧数字。
    window.addEventListener("tessera:workspace-refreshed", load);
    return () => {
      active = false;
      window.removeEventListener("tessera:workspace-refreshed", load);
    };
  }, []);
  if (!state || (!state.incompatible && !state.requeued)) return null;
  if (dismissed && state.incompatible <= dismissed.incompatible && state.requeued <= dismissed.requeued) return null;
  const dismiss = () => {
    const next = { incompatible: state.incompatible, requeued: state.requeued };
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {}
  };
  return (
    <aside role="status" className="compatibility-notice">
      <button
        type="button"
        className="icon-button compatibility-close"
        aria-label="关闭兼容性提示"
        title="关闭提示"
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {!!state.incompatible && (
        <p>
          {state.incompatible}{" "}
          个旧格式项目保留在数据库中，当前漏洞库和趋势不包含它们。旧格式没有自动迁移；请先备份并导出旧版本数据，再重建项目，重建后趋势从新项目开始。
        </p>
      )}
      {!!state.requeued && (
        <p>
          {state.requeued} 条历史发现需要按当前分类和证据规则重新审核，通过前不计入已确认漏洞与趋势。
          <a className="compatibility-action" href="#/reviews">
            前往审核队列
          </a>
        </p>
      )}
    </aside>
  );
}
