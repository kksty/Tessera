import type { ReactNode } from "react";
import { Route } from "lucide-react";
import { api, path } from "../api.js";
import { Badge } from "./ui.js";
import { CoverageTable } from "./CoverageTable.js";
import { HintControls } from "./HintControls.js";
import { scopeForNode } from "../graph-scope.js";
import { prettyText } from "../text.js";
import { fmt, stepState, useWorkspace } from "../workspace.js";
import { resolveGraphRelations } from "../../../../packages/protocol/src/graph-relations.js";
import { unmetDependencies } from "../../../../packages/protocol/src/step-chain.js";
import { GraphReference } from "./NodeHistory.js";
import { DOMAIN_LABEL, DOMAIN_ORDER } from "../graph-summary.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h3 className="detail-section-title">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="detail-field">
      <span className="detail-label">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </div>
  );
}

/** 黑板节点的详情正文。详情栏与「双击节点」弹窗共用，避免两处字段漂移。 */
export function NodeDetail() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const id = ws.id!;
  const { node, displayStep, displayFact, displayFinding, sources } = ws;
  if (!node) return null;
  const provenance = displayFact ? resolveGraphRelations(ws.visible ?? graph).facts.get(displayFact.id) : undefined;
  const isOrigin = displayFact?.id === "origin";
  const kind = displayStep
    ? "任务"
    : displayFinding
      ? "发现"
      : displayFact
        ? isOrigin
          ? "起点"
          : "事实"
        : graph.goals.some((goal) => goal.id === node.id)
          ? "目标"
          : "提示";
  const title = displayFinding?.title
    ? prettyText(displayFinding.title)
    : displayFact
      ? prettyText(displayFact.conclusion || displayFact.description)
      : "content" in node
        ? prettyText(node.content)
        : "description" in node
          ? prettyText(node.description)
          : "";
  const status = displayStep
    ? stepState(displayStep)
    : displayFinding
      ? displayFinding.review_status
      : !displayFact && "state" in node
        ? node.state
        : null;
  const blockedBy = displayStep ? unmetDependencies(graph, displayStep) : [];
  const hintRecord =
    !displayStep && !displayFact && !displayFinding ? graph.hints.find((hint) => hint.id === node.id) : undefined;
  // 提示与任务的关联不画进黑板，集中在这里展开，避免一条范围提示把图连成蛛网。
  const hintSteps = hintRecord
    ? graph.steps.filter((step) => !step.deleted && (step.hint_ids ?? []).includes(hintRecord.id))
    : [];

  return (
    <div className="detail-content">
      <header className="detail-head">
        <div className="detail-head-meta">
          <span className="detail-kind">{kind}</span>
          <button className="node-id" title="在黑板中高亮并定位" onClick={() => ws.setSelected(ws.selected)}>
            {ws.selected}
          </button>
          <span className="detail-spacer" />
          {ws.selected && (
            <button
              className="trace-chain"
              title={`查看 ${ws.selectedNodes.length > 1 ? ws.selectedNodes.join("、") : ws.selected} 的来路${displayStep ? "及直接产出" : ""}`}
              onClick={() => {
                const scope = scopeForNode(graph, ws.selected!);
                ws.setGraphScope(
                  ws.selectedNodes.length > 1
                    ? { ...scope, ids: [...ws.selectedNodes], label: `所选 ${ws.selectedNodes.length} 个节点的链路` }
                    : scope,
                );
                ws.setFocus({ id: ws.selected!, seq: (ws.focus?.seq ?? 0) + 1 });
              }}
            >
              <Route size={12} />
              {ws.selectedNodes.length > 1 ? "查看所选链路" : "只看这条链路"}
            </button>
          )}
        </div>
        <h2>{title}</h2>
        {status && (
          <div className="detail-status-row">
            <Badge value={status} />
          </div>
        )}
      </header>

      {hintRecord && (
        <Section title="关联任务">
          {hintSteps.length ? (
            <p className="detail-text">
              {hintSteps.map((step, index) => (
                <span key={step.id}>
                  {index > 0 && "、"}
                  <button className="node-id" onClick={() => ws.setSelected(step.id)}>
                    {step.id}
                  </button>
                </span>
              ))}
              <span className="detail-muted"> · 共 {hintSteps.length} 项</span>
            </p>
          ) : (
            <p className="detail-muted">暂无任务引用这条提示。</p>
          )}
        </Section>
      )}

      {displayStep && (
        <>
          <Section title="任务信息">
            {displayStep.property && (
              <Field label="验收属性">
                <p className="detail-text">{prettyText(displayStep.property)}</p>
              </Field>
            )}
            {displayStep.method_hint && (
              <Field label="方法建议">
                <p className="detail-text detail-muted">{prettyText(displayStep.method_hint)}</p>
              </Field>
            )}
            {displayStep.depends_on?.length ? (
              <Field
                label="前置任务"
                hint={blockedBy.length ? `等待前置执行（${blockedBy.join("、")}）` : "前置已就绪"}
              >
                <p className="detail-text">
                  {displayStep.depends_on.map((dependencyId, index) => (
                    <span key={dependencyId}>
                      {index > 0 && "、"}
                      <button className="node-id" onClick={() => ws.setSelected(dependencyId)}>
                        {dependencyId}
                      </button>
                    </span>
                  ))}
                  {blockedBy.length ? <span className="detail-muted"> · 等待前置</span> : null}
                </p>
              </Field>
            ) : null}
            <Field label="测试域" hint="仅用于分组与统计">
              <div className="step-domain">
                <select
                  aria-label="Step 测试域"
                  value={displayStep.test_domain ?? ""}
                  disabled={ws.busy || ws.replayIndex !== null}
                  onChange={(e) => {
                    const value = e.target.value;
                    void ws.action(() =>
                      api(
                        path(id, `/fgs/steps/${displayStep.id}/classification`),
                        { test_domain: value || null },
                        "PUT",
                      ),
                    );
                  }}
                >
                  <option value="">未分类</option>
                  {DOMAIN_ORDER.map((domain) => (
                    <option key={domain} value={domain}>
                      {DOMAIN_LABEL[domain]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="测试域细节"
                  placeholder="细节：如 提权：SUID（≤20 字）"
                  maxLength={20}
                  key={displayStep.id + (displayStep.focus ?? "")}
                  defaultValue={displayStep.focus ?? ""}
                  disabled={ws.busy || ws.replayIndex !== null}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value === (displayStep.focus ?? "")) return;
                    void ws.action(() =>
                      api(path(id, `/fgs/steps/${displayStep.id}/classification`), { focus: value }, "PUT"),
                    );
                  }}
                />
              </div>
            </Field>
            {!displayStep.concluded_at && !displayStep.discarded && !displayStep.worker && ws.replayIndex === null && (
              <Field label="任务描述" hint="下一轮决策直接读取">
                <textarea
                  aria-label="编辑任务描述"
                  defaultValue={displayStep.description}
                  key={displayStep.id + (displayStep.version ?? 1)}
                  rows={4}
                  disabled={ws.busy || graph.project.status !== "active"}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== displayStep.description)
                      void ws.action(() =>
                        api(
                          path(id, `/fgs/steps/${displayStep.id}`),
                          {
                            description: value,
                            expected_version: displayStep.version ?? 1,
                          },
                          "PUT",
                        ),
                      );
                  }}
                />
                {!!displayStep.edits?.length && (
                  <p className="detail-meta">已改写 {displayStep.edits.length} 次，原文保留在事件流中。</p>
                )}
              </Field>
            )}
            <Field label="优先级">
              <input
                type="number"
                aria-label="Step 优先级"
                defaultValue={displayStep.priority}
                key={displayStep.id + displayStep.priority}
                disabled={ws.replayIndex !== null || graph.project.status !== "active"}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n !== displayStep.priority)
                    void ws.action(() =>
                      api(
                        path(id, `/fgs/steps/${displayStep.id}`),
                        {
                          priority: n,
                        },
                        "PUT",
                      ),
                    );
                }}
              />
            </Field>
          </Section>

          <Section title="来源与产出">
            <Field label="来源">
              {sources.length ? (
                <div className="source-links">
                  {sources.map((s) => (
                    <GraphReference key={s} nodeId={s} onSelect={() => ws.setSelected(s)} />
                  ))}
                </div>
              ) : (
                <p className="detail-muted">没有记录来源</p>
              )}
            </Field>
            <Field label="产出事实">
              {displayStep.fact_ids.length ? (
                <div className="source-links">
                  {displayStep.fact_ids.map((f) => (
                    <GraphReference key={f} nodeId={f} onSelect={() => ws.setSelected(f)} />
                  ))}
                </div>
              ) : (
                <p className="detail-muted">尚未产出事实</p>
              )}
            </Field>
          </Section>

          <Section title="执行记录">
            <Field label="执行结果">
              <p className="detail-text">{prettyText(displayStep.summary) || "尚未提交结果"}</p>
            </Field>
            {displayStep.to === "goal" && (
              <details className="detail-completion" open={!!displayStep.completion}>
                <summary>
                  完成覆盖
                  {displayStep.completion
                    ? `（记录 ${displayStep.completion.coverage.length} 项）`
                    : "（历史项目未记录）"}
                </summary>
                <CoverageTable graph={graph} entries={displayStep.completion?.coverage ?? []} />
                {!displayStep.completion && (
                  <p className="detail-meta">
                    该项目完成时尚未强制记录覆盖表；上表由当前图的事实提取，处置状态为「未登记」。
                  </p>
                )}
              </details>
            )}
            <p className="detail-meta">
              领取 {displayStep.attempts} 次 · 创建于 {fmt(displayStep.created_at)}
            </p>
            {displayStep.retry_at && !displayStep.concluded_at && (
              <p className="detail-meta">
                {graph.project.status === "stopped"
                  ? "项目已暂停，自动重试停止。"
                  : `下次可领取：${fmt(displayStep.retry_at)}`}
              </p>
            )}
            {displayStep.worker && <p className="detail-meta">执行者 {displayStep.worker}</p>}
            {displayStep.discarded && (
              <Field label="废弃理由">
                <p className="detail-text">{displayStep.discard_reason || "未记录理由"}</p>
              </Field>
            )}
          </Section>

          {!displayStep.concluded_at && ws.replayIndex === null && (
            <div className="detail-actions">
              <button className="danger subtle" disabled={ws.busy} onClick={() => ws.setModal("discard")}>
                废弃这个方向
              </button>
            </div>
          )}
        </>
      )}

      {displayFact && (
        <>
          {!isOrigin && displayFact.conclusion && displayFact.description !== displayFact.conclusion && (
            <Section title="观测正文">
              <p className="detail-text detail-fact-body">{prettyText(displayFact.description)}</p>
              {displayFact.conclusion_inferred && <p className="detail-meta">该结论由正文推断，不是显式提交的结论。</p>}
            </Section>
          )}
          <Section title="观测信息">
            <Field label="观测状态">
              <p className="detail-text">
                {isOrigin
                  ? "项目起点"
                  : displayFact.status === "disputed"
                    ? "审核已指出结论问题，待重新验证"
                    : displayFact.status === "not_observed"
                      ? "未观测到（负面结论）"
                      : "观测事实"}
              </p>
            </Field>
            {displayFact.status === "not_observed" &&
              (!displayFact.request || !displayFact.parameter_sources?.length) && (
                <p className="detail-meta">负面结论缺少请求或参数溯源，Review 可能要求补证。</p>
              )}
            {displayFact.status === "not_observed" && (
              <Field label="负向范围">
                {displayFact.negative_scope?.attempted?.length ? (
                  <>
                    <div className="detail-meta">已尝试：</div>
                    <ul className="detail-bullets">
                      {displayFact.negative_scope.attempted.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                    {displayFact.negative_scope.not_tested?.length ? (
                      <>
                        <div className="detail-meta">未覆盖：</div>
                        <ul className="detail-bullets">
                          {displayFact.negative_scope.not_tested.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="detail-meta">未覆盖范围未记录，不表示没有缺口。</p>
                    )}
                    <p className="detail-meta">
                      提交者自评置信度：
                      {displayFact.negative_scope.confidence === "high"
                        ? "高"
                        : displayFact.negative_scope.confidence === "medium"
                          ? "中"
                          : "低"}
                    </p>
                  </>
                ) : (
                  <p className="detail-meta">未记录负向范围；这条结论只能视为本次未观测，不能证明方向已穷尽。</p>
                )}
              </Field>
            )}
            {!isOrigin && (
              <Field label="生产来源">
                {provenance?.ambiguous && (
                  <p className="detail-meta">历史生产关系有歧义，以下为全部候选，所属 Run 未知。</p>
                )}
                {provenance?.producers.length ? (
                  provenance.producers.map((producer) => (
                    <div key={producer.step_id} className="detail-producer">
                      <div className="source-links">
                        <GraphReference nodeId={producer.step_id} onSelect={() => ws.setSelected(producer.step_id)} />
                      </div>
                      <p className="detail-meta">
                        {producer.inferred ? "历史关联 · " : ""}Run：{producer.run_id || "未记录"}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="detail-muted">未记录生产任务</p>
                )}
              </Field>
            )}
            {displayFact.asset_id && (
              <Field label="资产">
                <code className="mono">{displayFact.asset_id}</code>
              </Field>
            )}
            {displayFact.created_at && <p className="detail-meta">观测于 {fmt(displayFact.created_at)}</p>}
          </Section>
          {!!displayFact.objects?.length && (
            <Section title="影响对象">
              <ul className="detail-fact-objects">
                {displayFact.objects.map((object) => (
                  <li key={object}>
                    <code className="mono">{object}</code>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {(displayFact.request || !!displayFact.parameter_sources?.length) && (
            <Section title="请求与参数溯源">
              {displayFact.request && (
                <Field label="请求">
                  <p className="detail-text mono detail-request">
                    {displayFact.request.method.toUpperCase()} {displayFact.request.url}
                  </p>
                </Field>
              )}
              {!!displayFact.parameter_sources?.length && (
                <Field label="参数来源">
                  <ul className="detail-fact-params">
                    {displayFact.parameter_sources.map((source) => (
                      <li key={`${source.parameter}-${source.source}`}>
                        <code className="mono">{source.parameter}</code>
                        <span className="detail-param-source">← {source.source}</span>
                        {!!source.evidence_ids?.length && (
                          <span className="detail-param-evidence">{ws.linkEvidence(source.evidence_ids)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
            </Section>
          )}
          {!!displayFact.evidence_ids.length && (
            <Section title="证据">
              <div className="detail-evidence-list">{ws.linkEvidence(displayFact.evidence_ids)}</div>
            </Section>
          )}
        </>
      )}

      {displayFinding && (
        <>
          <Section title="复现与证据">
            <p className="detail-text">{prettyText(displayFinding.evidence) || "尚未记录"}</p>
            {!!displayFinding.evidence_ids.length && (
              <div className="detail-evidence-list">{ws.linkEvidence(displayFinding.evidence_ids)}</div>
            )}
          </Section>
          <Section title="来源事实">
            {displayFinding.from.length ? (
              <div className="source-links">
                {displayFinding.from.map((f) => (
                  <GraphReference key={f} nodeId={f} onSelect={() => ws.setSelected(f)} />
                ))}
              </div>
            ) : (
              <p className="detail-muted">没有记录来源事实</p>
            )}
          </Section>
        </>
      )}

      {!displayStep && !displayFact && !displayFinding && "content" in node && (
        <>
          <p className="detail-note">
            人工提示。可在任务页搜索 {node.id}，查看描述中提及此提示的任务；文本提及不代表已回答。
          </p>
          <Section title="提示处理">
            <HintControls hintId={node.id} />
          </Section>
        </>
      )}
    </div>
  );
}
