import { useRef, useState } from "react";
import { RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { Finding } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { localPrefs } from "../layouts.js";
import { useWorkspace } from "../workspace.js";
import { Modal } from "./ui.js";

const actions = {
  delete: { label: "删除", icon: Trash2, detail: "从漏洞库、当前发现和新报告中移除此漏洞。原始证据、审核历史和已有报告快照保留。" },
  return: { label: "打回", icon: Undo2, detail: "退出漏洞库，标记为待补证据。Decide 根据说明修订或补证，之后重新提交 Review。" },
  retest: { label: "重测", icon: RotateCcw, detail: "退出漏洞库，创建带说明的定向重测任务。新证据提交到原漏洞 ID，完成后重新 Review。" },
} as const;
type Action = keyof typeof actions;

/** Only mounted on the Finding page; the blackboard remains a graph workspace. */
export function FindingActions({ finding }: { finding: Finding }) {
  const ws = useWorkspace(), submitting = useRef(false);
  const [action, setAction] = useState<Action | null>(null), [reason, setReason] = useState("");
  const reviewed = ws.graph!.reviews.some(review => review.finding_id === finding.id);
  if (!reviewed || finding.deleted || finding.merged_into || finding.withdrawn_at) return null;
  async function submit() {
    if (!action || !reason.trim() || submitting.current) return;
    submitting.current = true;
    try {
      const ok = await ws.action(() => api(path(ws.id!, `/findings/${finding.id}/actions`), {
        action, reason: reason.trim(), creator: localPrefs().actor_name, expected_version: finding.version,
      }));
      if (ok) { setAction(null); setReason(""); }
    } finally { submitting.current = false; }
  }
  return <section className="fd-card" aria-label="人工处理漏洞">
    <h3>人工处理</h3>
    <div className="fd-human-actions">
      {(Object.entries(actions) as [Action, typeof actions[Action]][]).map(([key, item]) => <button type="button" key={key}
        className={`button small${key === "delete" ? " danger" : ""}`} disabled={ws.busy}
        onClick={() => { setAction(key); setReason(""); }}><item.icon size={13} />{item.label}</button>)}
    </div>
    <p className="quiet">已通过 Review 的入库漏洞也可处理；操作说明与历史结论一并保留。</p>
    {action && <Modal label="人工处理漏洞" title={`${actions[action].label} · ${finding.id}`} busy={ws.busy}
      onClose={() => { if (!ws.busy) setAction(null); }}
      onSubmit={event => { event.preventDefault(); void submit(); }}
      footer={<><button type="button" className="button" disabled={ws.busy} onClick={() => setAction(null)}>取消</button>
        <button type="submit" className={`button ${action === "delete" ? "danger" : "primary"}`} disabled={ws.busy || !reason.trim()}>
          {ws.busy ? "正在提交…" : `确认${actions[action].label}`}</button></>}>
      <p>{finding.title} · v{finding.version}</p>
      <p>{actions[action].detail}</p>
      {ws.graph!.project.status === "stopped" && action !== "delete" && <p className="quiet">项目已暂停，任务与说明已保存，恢复项目后继续处理。</p>}
      {ws.graph!.project.status === "completed" && action !== "delete" && <p className="quiet">此操作会重新打开已完成项目，按说明继续处理。</p>}
      <label className="field"><span className="field-label">{action === "retest" ? "重测说明" : "操作说明"}</span>
        <textarea required maxLength={65536} rows={5} value={reason} onChange={event => setReason(event.target.value)}
          placeholder={action === "retest" ? "说明需验证的条件、预期行为和需要保留的证据。" : "说明处理原因及需要修订或补证的内容。"} /></label>
    </Modal>}
  </section>;
}
