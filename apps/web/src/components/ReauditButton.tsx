import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";

/**
 * 历史发现按当前分类/证据规则复核的入口。已完成或暂停的项目不会被审核队列领取，
 * 这里显式开一个只做审核的窗口，复核完自动恢复原状态，不重新规划探索。
 */
export function ReauditButton({
  projectId,
  onStarted,
  label = "重新审核",
  className = "button small",
  disabled = false,
}: {
  projectId: string;
  onStarted?: () => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  const ws = useWorkspace();
  const [starting, setStarting] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || starting || ws.busy}
      title="恢复项目并让审核模型按当前分类与证据规则重新审核待复核发现；复核结束后恢复原项目状态。"
      onClick={async () => {
        setStarting(true);
        const ok = await ws.action(() => api(path(projectId, "/reaudit"), {}, "POST"));
        setStarting(false);
        if (ok) onStarted?.();
      }}
    >
      <RotateCcw size={13} aria-hidden="true" />
      {starting ? "正在开始…" : label}
    </button>
  );
}
