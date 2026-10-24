import { useState } from "react";
import { X } from "lucide-react";
import { api, path } from "../api.js";
import { useWorkspace } from "../workspace.js";

/**
 * 结束正在进行的重新审核窗口。已经落地的审核结果保留，未完成的审核运行会停止；
 * 未产生新规划问题时项目回到开启复核前的状态，按钮不会重新规划或执行探索。
 */
export function CancelReauditButton({
  projectId,
  onCancelled,
  label = "取消复审",
  className = "button small ghost",
  disabled = false,
}: {
  projectId: string;
  onCancelled?: () => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  const ws = useWorkspace();
  const [cancelling, setCancelling] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || cancelling || ws.busy}
      title="停止本次重新审核；未完成的审核运行会结束，已经产生的审核结果会保留。"
      onClick={async () => {
        setCancelling(true);
        const ok = await ws.action(() => api(path(projectId, "/reaudit"), undefined, "DELETE"));
        setCancelling(false);
        if (ok) onCancelled?.();
      }}
    >
      <X size={13} aria-hidden="true" />
      {cancelling ? "正在取消…" : label}
    </button>
  );
}
