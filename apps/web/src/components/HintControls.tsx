import { useState } from "react";
import { Pencil, Undo2, Check, RotateCcw } from "lucide-react";
import { api, path } from "../api.js";
import { useWorkspace, stepState, locateRecord } from "../workspace.js";
import { Modal, Badge } from "./ui.js";

export function HintControls({ hintId }: { hintId: string }) {
  const ws = useWorkspace(),
    graph = ws.graph!,
    hint = graph.hints.find((h) => h.id === hintId);
  const [editing, setEditing] = useState(false),
    [withdrawing, setWithdrawing] = useState(false),
    [resolving, setResolving] = useState(false),
    [draft, setDraft] = useState(""),
    [note, setNote] = useState(""),
    [linked, setLinked] = useState<string[]>([]);
  if (!hint) return null;
  const tasks = graph.steps.filter((s) => s.hint_ids?.includes(hint.id)),
    pending = tasks.filter((s) => !s.concluded_at);
  if (hint.withdrawn_at) return <p className="quiet">提示已撤回；原始记录与已有产出仍保留在历史。</p>;
  return (
    <div className="hint-controls">
      <div className="hint-control-row">
        <label>
          优先级
          <input
            aria-label={`提示 ${hint.id} 优先级`}
            type="number"
            defaultValue={hint.priority || 0}
            key={hint.priority}
            onBlur={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value !== (hint.priority || 0))
                void ws.action(() => api(path(graph.project.id, `/hints/${hint.id}`), { priority: value }, "PUT"));
            }}
          />
        </label>
        <button
          onClick={() => {
            setDraft(hint.content);
            setLinked(tasks.map((s) => s.id));
            setEditing(true);
          }}
        >
          <Pencil size={13} />
          编辑 / 关联
        </button>
        {hint.resolved ? (
          <button
            disabled={ws.busy || graph.project.status === "completed"}
            title={
              graph.project.status === "completed" ? "项目已完成；先在项目操作里继续评估，再重开提示" : "重新打开该提示"
            }
            onClick={() =>
              void ws.action(() => api(path(graph.project.id, `/hints/${hint.id}/resolve`), { by: "human" }, "DELETE"))
            }
          >
            <RotateCcw size={13} />
            重新打开
          </button>
        ) : (
          <button
            className="primary"
            disabled={ws.busy}
            onClick={() => {
              setNote("");
              setResolving(true);
            }}
          >
            <Check size={13} />
            确认关闭
          </button>
        )}
        <button disabled={ws.busy} onClick={() => setWithdrawing(true)}>
          <Undo2 size={13} />
          撤回
        </button>
      </div>
      <small>
        {hint.resolved
          ? hint.resolved_by === "operator"
            ? `已由人工确认：${hint.resolved.note}（${hint.resolved.worker}）`
            : `历史备注关闭（${hint.resolved.worker}），尚未经过新的操作员确认；请核对后重新确认或重开`
          : tasks.length
            ? `已落实到任务 ${tasks.map((step) => step.id).join("、")}；仍需人工确认后才能完成项目`
            : "尚未落实：下一轮 Decide 应建任务，或说明不采纳的理由；说明本身不会关闭提示"}
      </small>
      {!hint.resolved && (hint.notes?.length ?? 0) > 0 && (
        <small className="quiet">Decide 建议：{hint.notes?.at(-1)?.note}</small>
      )}
      <small>数字越大越先领取关联任务；不会抢占正在运行的任务。</small>
      {tasks.map((step) => (
        <button key={step.id} className="hint-task-link" onClick={() => locateRecord(ws, step.id)}>
          {step.id}
          <Badge value={stepState(step)} />
          <span>{step.fact_ids.length} 条事实</span>
        </button>
      ))}
      {resolving && (
        <Modal
          label="确认关闭人工提示"
          title={`确认 ${hint.id}`}
          onClose={() => setResolving(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void ws
              .action(() =>
                api(path(graph.project.id, `/hints/${hint.id}/resolve`), {
                  note: note.trim() || undefined,
                  by: "human",
                }),
              )
              .then((ok) => {
                if (ok) setResolving(false);
              });
          }}
          footer={
            <>
              <button type="button" onClick={() => setResolving(false)}>
                取消
              </button>
              <button className="primary" disabled={ws.busy}>
                确认关闭
              </button>
            </>
          }
        >
          <p>{hint.content}</p>
          <label>
            确认说明（可选）
            <textarea
              aria-label="确认说明"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="例如：已人工复核，本条不再需要单独的任务"
            />
          </label>
          <p className="quiet">确认后本条提示退出完成阻塞；若仍需跟踪，可随时重新打开。</p>
        </Modal>
      )}
      {editing && (
        <Modal
          label="编辑人工提示"
          title={`编辑 ${hint.id}`}
          onClose={() => setEditing(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void ws
              .action(() =>
                api(path(graph.project.id, `/hints/${hint.id}`), { content: draft, step_ids: linked }, "PUT"),
              )
              .then((ok) => {
                if (ok) setEditing(false);
              });
          }}
          footer={
            <>
              <button type="button" onClick={() => setEditing(false)}>
                取消
              </button>
              <button className="primary" disabled={ws.busy || !draft.trim()}>
                保存提示
              </button>
            </>
          }
        >
          <label>
            提示内容
            <textarea
              aria-label="提示内容"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              required
            />
          </label>
          <p className="quiet">
            修改内容会停止原关联方向的未完成任务并交给 Decide
            重新规划，已提交事实与证据保留。仅关联任务或改优先级不会停止任务。
          </p>
          <fieldset className="hint-task-picker">
            <legend>关联现有任务</legend>
            {graph.steps
              .filter((s) => !s.concluded_at || tasks.some((t) => t.id === s.id))
              .map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={linked.includes(s.id)}
                    onChange={(e) =>
                      setLinked(e.target.checked ? [...linked, s.id] : linked.filter((id) => id !== s.id))
                    }
                  />
                  <span>
                    {s.id} · {s.description}
                  </span>
                </label>
              ))}
          </fieldset>
        </Modal>
      )}
      {withdrawing && (
        <Modal
          label="撤回人工提示"
          title={`撤回 ${hint.id}`}
          onClose={() => setWithdrawing(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void ws
              .action(() => api(path(graph.project.id, `/hints/${hint.id}`), {}, "DELETE"))
              .then((ok) => {
                if (ok) setWithdrawing(false);
              });
          }}
          footer={
            <>
              <button type="button" onClick={() => setWithdrawing(false)}>
                取消
              </button>
              <button className="danger" disabled={ws.busy}>
                撤回提示
              </button>
            </>
          }
        >
          <p>{hint.content}</p>
          <p className="quiet">
            将停止 {pending.length} 项关联未完成任务。已提交事实、证据和历史保留，不删除已有结果。
          </p>
          {!tasks.length && (
            <p className="quiet">
              尚未关联任务。撤回不会自动停止仅在文字中提及此提示的旧任务；可先编辑并关联，或单独废弃该任务。
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
