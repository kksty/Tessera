import { useState } from "react";
import type { Step } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { prettyText } from "../text.js";
import { useWorkspace } from "../workspace.js";
import { Modal } from "./ui.js";

/**
 * Human close/reopen. Closing is a decision with a reason, not an execution result;
 * reopening clears executed_at so the next claim reruns the Step directly.
 */
export function StepDecision({ step, onClose, onDone }: { step: Step; onClose: () => void; onDone?: () => void }) {
  const ws = useWorkspace();
  const reopening = !!step.concluded_at;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim() || !ws.graph) return;
    setBusy(true);
    const ok = await ws.action(() =>
      api(path(ws.graph!.project.id, `/steps/${step.id}/${reopening ? "reopen" : "close"}`), {
        reason: reason.trim(),
        worker: "human",
        expected_version: step.version,
      }),
    );
    setBusy(false);
    if (ok) {
      onClose();
      onDone?.();
    }
  }
  return (
    <Modal
      label={reopening ? "重开任务" : "关闭任务"}
      title={reopening ? "重开任务" : "关闭任务"}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="button primary" disabled={busy || !reason.trim()}>
            {reopening ? "确认重开" : "确认关闭"}
          </button>
        </>
      }
    >
      <p className="quiet">
        {reopening
          ? "重开会清空执行与关闭记录，下一次领取直接重跑；旧事实与发现保留。"
          : step.executed_at
            ? "执行已经结束，但问题是否答够只有决策者能判断。关闭必须写理由。"
            : "关闭表示这个问题已答够、被证伪或放弃。关闭必须写理由。"}
      </p>
      <p className="step-target mono">
        {step.id} · v{step.version}：{step.description}
      </p>
      {step.property && (
        <p className="step-property">
          <span className="field-label">验收属性</span>
          {prettyText(step.property)}
        </p>
      )}
      {step.method_hint && (
        <p className="quiet">
          <span className="field-label">方法建议</span>
          {prettyText(step.method_hint)}
        </p>
      )}
      {step.close_reason && <p className="quiet">原关闭理由：{step.close_reason}</p>}
      <label className="field">
        <span className="field-label">理由</span>
        <textarea required autoFocus value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
    </Modal>
  );
}
