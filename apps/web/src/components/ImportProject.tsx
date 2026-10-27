import { useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Archive, CheckCircle2, FileArchive, Upload } from "lucide-react";
import { apiUpload } from "../api.js";
import { fmtBytes } from "../format.js";
import { useWorkspace } from "../workspace.js";
import { Modal } from "./ui.js";

/** 服务端 /projects/import 的返回；只声明界面消费的字段。 */
type ImportedProject = {
  project_id: string;
  title: string;
  status: "active" | "stopped" | "completed";
  created_at: string;
  counts: Record<string, number>;
  warnings: string[];
};

const countLabels: [string, string][] = [
  ["facts", "事实"],
  ["steps", "任务"],
  ["findings", "发现"],
  ["evidence", "证据原件"],
  ["events", "事件"],
  ["runs", "运行"],
  ["diagnostics", "诊断日志"],
  ["traffic", "流量记录"],
  ["reports", "报告"],
];

/** 项目页的整份备份导入入口：选择 ZIP → 保留原 ID 恢复 → 直接进入项目。 */
export function ImportProject() {
  const ws = useWorkspace(),
    input = useRef<HTMLInputElement>(null),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [imported, setImported] = useState<ImportedProject | null>(null);

  function close() {
    if (busy) return;
    setFile(null);
    setImported(null);
    setError("");
    if (input.current) input.current.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (imported) {
      close();
      ws.openProject(imported.project_id);
      return;
    }
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiUpload<ImportedProject>("/projects/import", file);
      // 列表刷新失败不代表导入失败：项目已经在服务端写好，继续进入即可。
      await ws.refresh().catch(() => {});
      // 没有缺失原件时直接进入项目；有警告时先让操作员看到缺口。
      if (!result.warnings.length) {
        setFile(null);
        ws.setMessage(`已导入「${result.title}」`);
        ws.openProject(result.project_id);
      } else setImported(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (!chosen) return;
          setImported(null);
          setError("");
          setFile(chosen);
        }}
      />
      <button type="button" className="button ghost" onClick={() => input.current?.click()}>
        <Upload size={14} />
        导入项目
      </button>
      {(file || imported) && (
        <Modal
          label="导入项目备份"
          title={imported ? `已导入「${imported.title}」` : "导入项目备份"}
          onClose={close}
          onSubmit={submit}
          busy={busy}
          width={560}
          footer={
            <>
              <button type="button" disabled={busy} onClick={close}>
                取消
              </button>
              <button type="submit" className="primary" disabled={busy || (!file && !imported)}>
                {busy ? "正在导入…" : imported ? "进入项目" : "开始导入"}
              </button>
            </>
          }
        >
          {imported ? (
            <>
              <p className="banner" role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span className="banner-text">
                  项目已恢复为 <code>{imported.project_id}</code>，状态为
                  {imported.status === "active" ? "运行中" : imported.status === "stopped" ? "已暂停" : "已完成"}。
                </span>
              </p>
              <dl className="meta-list">
                {countLabels
                  .filter(([key]) => imported.counts[key] !== undefined)
                  .map(([key, label]) => (
                    <div key={key} style={{ display: "contents" }}>
                      <dt>{label}</dt>
                      <dd>{imported.counts[key]}</dd>
                    </div>
                  ))}
              </dl>
              {imported.warnings.length > 0 && (
                <div className="banner warn" role="alert">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span className="banner-text">
                    导入完成，但有 {imported.warnings.length} 条缺口需要注意：
                    <ul>
                      {imported.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                <FileArchive size={14} aria-hidden="true" /> <code>{file?.name}</code>
                {file ? ` · ${fmtBytes(file.size)}` : ""}
              </p>
              <p>
                整份备份包含探索图、事件与运行日志、诊断、流量正文、报告以及证据原件；导入会保留
                <strong>原项目 ID</strong>，同一 ID 已存在时拒绝导入，不会覆盖现有项目。
              </p>
              <p className="quiet">
                导出时仍在运行的 Run 会在导入后标记为中断，租约被清理；项目可以直接继续领取任务。 备份不包含 Docker
                工作区卷、模型密钥或本机运行设置。
              </p>
              <div className="banner" role="note">
                <Archive size={15} aria-hidden="true" />
                <span className="banner-text">
                  导入过程会先完整校验 ZIP 内每个条目的校验和与证据 SHA-256；校验失败不会写入任何记录。
                </span>
              </div>
              {error && (
                <p className="banner danger" role="alert">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span className="banner-text">{error}</span>
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
