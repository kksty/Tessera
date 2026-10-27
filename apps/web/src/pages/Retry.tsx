import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CircleCheckBig,
  FileText,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { Evidence, Run, Step } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { Card, EmptyState, Kpi, Modal, PageHeader } from "../components/ui.js";
import { StepDecision } from "../components/StepDecision.js";
import { fmt, locateRecord, readableError, useWorkspace } from "../workspace.js";
import { DEFAULT_RUN_LIMIT, runAttention, type RunAttention } from "../run-state.js";
import { useRuns } from "../runs.js";
import { prettyText } from "../text.js";

interface EvidenceIndex {
  count: number;
  latest: Evidence;
}

interface AttentionRow {
  run: Run;
  step?: Step;
  attention: RunAttention | null;
  evidence?: EvidenceIndex;
}

function secondsOf(run: Run) {
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  return Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
}

/** 把“为什么这次会停”翻译成用户看得懂、能据此判断的提示。 */
function failureHint(run: Run) {
  const error = readableError(run.error || "");
  if (/lease expired/i.test(error)) return "租约过期通常来自服务重启或心跳中断：命令可能已经发出，但结果没来得及提交。";
  if (/timeout/i.test(error)) return "上次执行超时，可能已经留下部分结果；先看证据再决定是否重跑。";
  if (/connection|network|fetch|ECONN|socket/i.test(error))
    return "上次是连接失败；先确认网络或模型端点已经恢复，否则同一个原因会再次失败。";
  if (/cancel|terminated|killed|终止/i.test(error))
    return "上次被中断时可能已有外部动作；确认目标状态后再决定是否重跑。";
  return "先确认失败原因已经消失；同一个原因会再次失败。";
}

function evidenceHint(evidence?: EvidenceIndex) {
  if (!evidence) return "这次运行没有留下证据：先确认它是否真的执行过，无证据时重试最容易重复外部动作。";
  return `已有 ${evidence.count} 份证据。若结果已经够用，优先关闭任务并用现有证据补交 Fact；重试会再次执行同一任务。`;
}

export function RetryPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const projectId = graph.project.id;
  const { runs, error, reload } = useRuns(projectId, DEFAULT_RUN_LIMIT);
  const [retryTarget, setRetryTarget] = useState<AttentionRow | null>(null);
  const [closeTarget, setCloseTarget] = useState<Step | null>(null);

  const steps = useMemo(() => new Map(graph.steps.map((step) => [step.id, step])), [graph.steps]);
  const evidence = useMemo(() => {
    const index = new Map<string, EvidenceIndex>();
    for (const item of graph.evidence) {
      if (!item.step_id) continue;
      const current = index.get(item.step_id);
      if (!current) index.set(item.step_id, { count: 1, latest: item });
      else if (Date.parse(item.created_at) >= Date.parse(current.latest.created_at)) {
        current.count += 1;
        current.latest = item;
      } else current.count += 1;
    }
    return index;
  }, [graph.evidence]);

  const rows = useMemo<AttentionRow[]>(
    () =>
      runs.map((run) => {
        const step = run.node_id ? steps.get(run.node_id) : undefined;
        return {
          run,
          step,
          attention: runAttention(run, step),
          evidence: step ? evidence.get(step.id) : undefined,
        };
      }),
    [runs, steps, evidence],
  );
  const pending = useMemo(
    () =>
      rows.filter((row) => row.attention?.actionable).sort((a, b) => a.run.started_at.localeCompare(b.run.started_at)),
    [rows],
  );
  const history = useMemo(
    () => rows.filter((row) => row.run.status === "needs_attention" && !row.attention?.actionable).slice(0, 12),
    [rows],
  );
  const affectedSteps = useMemo(() => new Set(pending.map((row) => row.step?.id).filter(Boolean)).size, [pending]);
  const externalActions = pending.filter((row) => row.run.external_action_possible).length;

  function refresh() {
    void ws.refresh();
    reload();
  }

  function openEvidence(item?: Evidence) {
    if (!item) return;
    ws.navigate("evidence");
    void ws.showEvidence(item);
  }

  return (
    <section className="page page-retry">
      <PageHeader
        eyebrow="RECOVERY / MANUAL RETRY"
        title="人工重试"
        description="执行中断后，自动重试会停在这里。先核对原始证据和外部动作，再决定重跑、关闭任务、还是让 Decide 用现有结果继续。"
        actions={
          <>
            <span className="status-pill" data-tone={pending.length ? "danger" : "neutral"}>
              <i aria-hidden="true" />
              {pending.length ? `${pending.length} 次待处理` : "没有待处理"}
            </span>
            <button type="button" className="button ghost" disabled={ws.refreshing || ws.busy} onClick={refresh}>
              <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} />
              刷新
            </button>
          </>
        }
      />

      {error && (
        <p className="banner danger" role="alert">
          <AlertTriangle size={15} />
          <span className="banner-text">{error}</span>
        </p>
      )}
      {graph.project.status !== "active" && (
        <p className="banner warn" role="status">
          <TriangleAlert size={15} />
          <span className="banner-text">
            项目当前{graph.project.status === "stopped" ? "已暂停" : "不在运行状态"}。确认重试只会解除任务阻塞， Worker
            要等项目继续后才会领取。
          </span>
        </p>
      )}

      <div className="kpi-grid">
        <Kpi
          label="待人工重试"
          value={pending.length}
          tone={pending.length ? "danger" : "neutral"}
          note={pending.length ? "这些运行会阻塞对应任务" : "没有中断后等待确认的运行"}
          icon={<RotateCcw size={14} />}
        />
        <Kpi label="涉及任务" value={affectedSteps} note="同一次任务只算一次" icon={<ShieldCheck size={14} />} />
        <Kpi
          label="可能已执行外部动作"
          value={externalActions}
          tone={externalActions ? "warn" : "neutral"}
          note={externalActions ? "重试前重点核对证据" : "没有记录到外部动作"}
          icon={<TriangleAlert size={14} />}
        />
      </div>

      <Card title="先判断，再重试" icon={<ShieldCheck size={16} />} note="自动重试已停止，这一步由你拍板">
        <ol className="retry-guide">
          <li>
            <span className="retry-guide-num">1</span>
            <div>
              <strong>先看原始证据</strong>
              <p>证据里有结果但没来得及提交时，重跑会重复外部动作；先确认这次运行到底留下了什么。</p>
            </div>
          </li>
          <li>
            <span className="retry-guide-num">2</span>
            <div>
              <strong>再看外部影响</strong>
              <p>shell、gogo、curl 等动作可能已经发送。确认目标允许重复请求，且上次没有未归档的结果。</p>
            </div>
          </li>
          <li>
            <span className="retry-guide-num">3</span>
            <div>
              <strong>最后选动作</strong>
              <p>
                已有结果 → 关闭任务，让 Decide 用现有证据补交；需要继续执行 → 确认重试；目标不可达 →
                先修网络，重试不会解决。
              </p>
            </div>
          </li>
        </ol>
      </Card>

      <Card
        title="待处理"
        note={pending.length ? `${pending.length} 次运行等待人工确认` : "队列已清空"}
        actions={
          <button type="button" className="button ghost small" onClick={() => ws.navigate("tasks")}>
            查看任务与运行
          </button>
        }
        flush
      >
        {pending.length ? (
          <div className="retry-list">
            {pending.map((row) => (
              <RetryCard
                key={row.run.id}
                row={row}
                onRetry={() => setRetryTarget(row)}
                onCloseStep={() => row.step && setCloseTarget(row.step)}
                onEvidence={() => openEvidence(row.evidence?.latest)}
              />
            ))}
          </div>
        ) : (
          <div className="retry-empty">
            <EmptyState
              icon={<CircleCheckBig size={20} />}
              title="没有待人工重试的运行"
              desc="执行中断会自动停在这里；处理完最后一次中断后，这里会恢复为空。"
              action={
                <button type="button" className="button" onClick={() => ws.navigate("tasks")}>
                  查看任务与运行
                </button>
              }
            />
          </div>
        )}
      </Card>

      {history.length > 0 && (
        <Card title="最近已处理" note="原运行、证据与用量保留" flush>
          <div className="retry-history">
            {history.map((row) => (
              <div className="retry-history-row" key={row.run.id}>
                <span className="status-pill" data-tone="neutral">
                  <i aria-hidden="true" />
                  已处理
                </span>
                <span className="mono">{row.run.node_id || "—"}</span>
                <span className="retry-history-note">{row.attention?.note}</span>
                <span className="spacer" />
                <time dateTime={row.run.finished_at || row.run.started_at}>
                  {fmt(row.run.finished_at || row.run.started_at)}
                </time>
              </div>
            ))}
          </div>
        </Card>
      )}

      {retryTarget && (
        <RetryDialog
          row={retryTarget}
          onClose={() => setRetryTarget(null)}
          onDone={() => {
            reload();
            setRetryTarget(null);
          }}
          onEvidence={() => openEvidence(retryTarget.evidence?.latest)}
        />
      )}
      {closeTarget && <StepDecision step={closeTarget} onClose={() => setCloseTarget(null)} onDone={reload} />}
    </section>
  );
}

function RetryCard({
  row,
  onRetry,
  onCloseStep,
  onEvidence,
}: {
  row: AttentionRow;
  onRetry: () => void;
  onCloseStep: () => void;
  onEvidence: () => void;
}) {
  const ws = useWorkspace();
  const step = row.step!;
  const run = row.run;

  return (
    <article className="retry-card">
      <header className="retry-card-head">
        <span className="status-pill" data-tone="danger">
          <i aria-hidden="true" />
          需人工检查
        </span>
        <span className="retry-kind">Execute</span>
        <button type="button" className="retry-step mono" onClick={() => locateRecord(ws, step.id)}>
          {step.id}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
        <span className="quiet">
          第 {run.attempt} 次 · {fmt(run.started_at)}
        </span>
        <span className="spacer" />
        {run.external_action_possible && (
          <span className="retry-flag">
            <AlertTriangle size={12} aria-hidden="true" />
            外部动作可能已发生
          </span>
        )}
      </header>

      <p className="retry-desc">{prettyText(step.description)}</p>

      <p className="retry-error">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{readableError(run.error) || "未记录失败原因"}</span>
      </p>
      <p className="retry-hint">{failureHint(run)}</p>

      <div className="retry-meta">
        <span>
          运行 <span className="mono">{run.id}</span>
        </span>
        <span>耗时 {secondsOf(run)} 秒</span>
        <span>请求 {run.request_count} 次</span>
        <span>证据 {row.evidence?.count ?? 0} 份</span>
      </div>

      <div className="retry-evidence">
        <FileText size={14} aria-hidden="true" />
        {row.evidence ? (
          <>
            <span>最新证据</span>
            <button type="button" className="retry-evidence-link" onClick={onEvidence}>
              {prettyText(row.evidence.latest.title)}
            </button>
          </>
        ) : (
          <span className="quiet">这次运行没有留下证据</span>
        )}
      </div>
      <p className="retry-hint quiet">{evidenceHint(row.evidence)}</p>

      <footer className="retry-actions">
        <button type="button" className="button small" disabled={!row.evidence} onClick={onEvidence}>
          <FileText size={12} />
          查看证据
        </button>
        <button type="button" className="button small" onClick={() => locateRecord(ws, step.id)}>
          查看任务
        </button>
        <button type="button" className="button small" onClick={onCloseStep}>
          关闭任务
        </button>
        <span className="spacer" />
        <button type="button" className="button small danger" onClick={onRetry}>
          <RotateCcw size={12} />
          确认重试
        </button>
      </footer>
    </article>
  );
}

function RetryDialog({
  row,
  onClose,
  onDone,
  onEvidence,
}: {
  row: AttentionRow;
  onClose: () => void;
  onDone: () => void;
  onEvidence: () => void;
}) {
  const ws = useWorkspace();
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState("");
  const step = row.step!;
  const run = row.run;

  async function retry() {
    if (!confirmed) return;
    setFailure("");
    const ok = await ws.action(async () => {
      try {
        await api(path(run.project_id, `/runs/${run.id}/retry`), { confirmed: true });
      } catch (error) {
        setFailure(readableError(error instanceof Error ? error.message : "重试失败") || "重试失败");
        throw error;
      }
    });
    if (ok) onDone();
  }

  return (
    <Modal
      label="确认人工重试"
      title="确认人工重试"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={ws.busy}>
            取消
          </button>
          <button type="button" className="button ghost" onClick={onEvidence} disabled={ws.busy || !row.evidence}>
            查看证据
          </button>
          <button type="button" className="button danger" disabled={ws.busy || !confirmed} onClick={() => void retry()}>
            <RotateCcw size={14} />
            {ws.busy ? "提交中…" : "确认重试"}
          </button>
        </>
      }
    >
      <p className="retry-modal-warn">
        <AlertTriangle size={15} aria-hidden="true" />
        <span>
          这个运行没有正常结束。重试不是“继续上次”，而是让同一个任务再执行一次；上次可能已经发出的请求会再次发出。
        </span>
      </p>

      {failure && (
        <p className="banner danger" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="banner-text">{failure}</span>
        </p>
      )}

      <p className="retry-modal-explain">
        重试会解除 <strong>{step.id}</strong> 的阻塞标记，让调度器以同一任务第 {run.attempt + 1}{" "}
        次尝试重新领取。不会新建任务；原运行记录、原始证据和用量都会保留。
      </p>

      <div className="retry-modal-box">
        <p>
          <strong>失败原因</strong>
          <span>{readableError(run.error) || "未记录失败原因"}</span>
        </p>
        <p>
          <strong>判断提示</strong>
          <span>{failureHint(run)}</span>
        </p>
        <p>
          <strong>现有材料</strong>
          <span>{evidenceHint(row.evidence)}</span>
        </p>
      </div>

      <p className="retry-modal-info">
        <Info size={14} aria-hidden="true" />
        <span>
          如果证据里已经有结果，只是没来得及提交：取消重试，回到列表点“关闭任务”，再让 Decide
          用现有证据规划补交，通常比重复扫描更安全。
        </span>
      </p>

      <label className="retry-check">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>
          我已核对原始证据，并接受重试会再次执行 <strong>{step.id}</strong>
          {run.external_action_possible ? "、可能重复已发出的外部请求" : ""}。
        </span>
      </label>
    </Modal>
  );
}
