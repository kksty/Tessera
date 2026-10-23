import { lazy, Suspense, useMemo, useState } from "react";
import { Activity, Clock3, Globe2, RefreshCw, Search, ShieldCheck, Snowflake } from "lucide-react";
import type { Asset, Evidence } from "../../../../packages/protocol/src/index.js";
import { api, path } from "../api.js";
import { EmptyState, Kpi, Modal, PageHeader, Segmented, StatusPill } from "../components/ui.js";
import { fmt } from "../format.js";
import { useViewState } from "../view-state.js";
import { useWorkspace } from "../workspace.js";

type AssetView = "list" | "map";
const AssetMap = lazy(() => import("../AssetMap.js").then(({ AssetMap }) => ({ default: AssetMap })));

/** 批准状态文案：pending 在通用标签里是「待审核」，这里必须写清是待批准。 */
const approvalLabels: Record<Asset["approval"], string> = {
  approved: "已批准",
  pending: "待批准",
  rejected: "已拒绝",
};

export function AssetsPage() {
  const ws = useWorkspace();
  const graph = ws.graph!;
  const id = ws.id!;
  const [view, setView] = useViewState<AssetView>(`${graph.project.id}:assets:view`, "list");
  const [revoking, setRevoking] = useState<Asset | null>(null);
  const [cooling, setCooling] = useState<Asset | null>(null);
  const [reason, setReason] = useState("");

  const assets = ws.filteredAssets;
  const evidenceByAsset = useMemo(() => {
    const map = new Map<string, Evidence[]>();
    for (const item of graph.evidence) {
      if (!item.asset_id) continue;
      const list = map.get(item.asset_id);
      if (list) list.push(item);
      else map.set(item.asset_id, [item]);
    }
    for (const list of map.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return map;
  }, [graph.evidence]);

  const pending = assets.filter((asset) => asset.approval === "pending");
  const selectedPending = pending.filter((asset) => ws.checked.includes(asset.id));
  const approved = graph.assets.filter((asset) => asset.approval === "approved").length;
  const pendingTotal = graph.assets.filter((asset) => asset.approval === "pending").length;
  const seedTotal = graph.assets.filter((asset) => asset.seed).length;
  const testing = new Set(
    graph.steps
      .filter((step) => step.asset_id && step.worker && !step.concluded_at)
      .map((step) => step.asset_id),
  ).size;
  const isExploring = (assetId: string) =>
    graph.steps.some((step) => step.asset_id === assetId && step.worker && !step.concluded_at);
  const allPendingSelected =
    pending.length > 0 && pending.every((asset) => ws.checked.includes(asset.id));

  const approve = (ids: string[]) => ws.action(() => api(path(id, "/assets/approve"), { ids }));
  const revoke = (asset: Asset) =>
    ws
      .action(() => api(path(id, "/assets/revoke"), { ids: [asset.id] }))
      .then((ok) => {
        if (ok) setRevoking(null);
      });
  const setInterest = (asset: Asset, cooldown: "auto" | "cooled", note?: string) =>
    ws.action(() =>
      api(
        path(id, `/assets/${encodeURIComponent(asset.id)}`),
        { cooldown_override: cooldown, ...(note ? { reason: note } : {}) },
        "PUT",
      ),
    );

  return (
    <section className="page page-assets">
      <PageHeader
        eyebrow="SCOPE / ASSETS"
        title="资产与范围"
        description="种子与发现资产先进入范围、再接受测试：只有已批准的资产会被规划。撤销批准会把资产退回待批准，并取消它未完成的任务。"
        meta={
          <>
            <span className="tag">种子 {seedTotal}</span>
            <span className="tag">发现 {graph.assets.length - seedTotal}</span>
            <span className="tag">证据 {graph.evidence.length}</span>
          </>
        }
        actions={
          <>
            {selectedPending.length > 0 && (
              <button
                type="button"
                className="button primary"
                disabled={ws.busy}
                onClick={() =>
                  void approve(selectedPending.map((asset) => asset.id)).then((ok) => {
                    if (ok) ws.setChecked([]);
                  })
                }
              >
                批准所选 {selectedPending.length}
              </button>
            )}
            <button
              type="button"
              className="button ghost"
              disabled={ws.refreshing}
              onClick={() => void ws.refresh()}
            >
              <RefreshCw size={14} className={ws.refreshing ? "spin" : undefined} aria-hidden="true" />
              刷新
            </button>
          </>
        }
      />

      <div className="kpi-grid">
        <Kpi
          label="资产总数"
          value={graph.assets.length}
          icon={<Globe2 size={15} aria-hidden="true" />}
          note={`种子 ${seedTotal} · 发现 ${graph.assets.length - seedTotal}`}
        />
        <Kpi
          label="已批准"
          value={approved}
          icon={<ShieldCheck size={15} aria-hidden="true" />}
          note="可进入探索范围"
        />
        <Kpi
          label="待批准"
          value={pendingTotal}
          tone={pendingTotal ? "warn" : "neutral"}
          icon={<Clock3 size={15} aria-hidden="true" />}
          note={pendingTotal ? "批准后才会被规划" : "没有等待批准的范围变更"}
        />
        <Kpi
          label="正在测试"
          value={testing}
          tone={testing ? "accent" : "neutral"}
          icon={<Activity size={15} aria-hidden="true" />}
          note="关联未完成任务"
        />
      </div>

      <div className="toolbar">
        <Segmented
          ariaLabel="资产视图"
          value={view}
          onChange={setView}
          options={[
            ["list", "列表"],
            ["map", "资产星图"],
          ]}
        />
        <label className="search-input">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="搜索资产主机名"
            placeholder="搜索主机名"
            value={ws.query}
            onChange={(event) => ws.setQuery(event.target.value)}
          />
        </label>
        <span className="spacer" />
        {view === "list" ? (
          <>
            <label className="assets-select-all">
              <input
                className="assets-check"
                type="checkbox"
                checked={allPendingSelected}
                disabled={!pending.length}
                onChange={(event) =>
                  ws.setChecked(event.target.checked ? pending.map((asset) => asset.id) : [])
                }
              />
              选择全部待批准
            </label>
            <span className="toolbar-hint">
              已选 {selectedPending.length} 个 · 显示 {assets.length} / {graph.assets.length} 个
            </span>
          </>
        ) : (
          <span className="toolbar-hint">星图与搜索联动 · 颜色表示批准状态</span>
        )}
      </div>

      {view === "map" ? (
        <div className="assets-map-frame">
          <Suspense fallback={<div className="empty-state" role="status">正在加载资产地图…</div>}>
            <AssetMap />
          </Suspense>
        </div>
      ) : graph.assets.length === 0 ? (
        <div className="data-table-wrap">
          <EmptyState
            icon={<Globe2 size={20} aria-hidden="true" />}
            title="还没有资产"
            desc="创建项目时填写的指定站点会成为种子资产；探索中发现的主机先进入待批准列表，不会被自动测试。"
          />
        </div>
      ) : assets.length === 0 ? (
        <div className="data-table-wrap">
          <EmptyState
            icon={<Search size={20} aria-hidden="true" />}
            title="没有匹配的资产"
            desc={`没有主机名包含「${ws.query.trim()}」的资产。`}
            action={
              <button type="button" className="button small" onClick={() => ws.setQuery("")}>
                清除搜索
              </button>
            }
          />
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table assets-table">
            <thead>
              <tr>
                <th className="assets-col-check">
                  <span className="sr-only">选择</span>
                </th>
                <th>主机名</th>
                <th>来源</th>
                <th>批准状态</th>
                <th>冷处理</th>
                <th>创建时间</th>
                <th className="assets-col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const evidence = evidenceByAsset.get(asset.id) || [];
                const latest = evidence[0];
                return (
                  <tr key={asset.id} className="assets-row" data-approval={asset.approval}>
                    <td className="assets-col-check">
                      <input
                        className="assets-check"
                        type="checkbox"
                        aria-label={`选择 ${asset.hostname}`}
                        disabled={asset.approval !== "pending"}
                        checked={ws.checked.includes(asset.id)}
                        onChange={(event) =>
                          ws.setChecked(
                            event.target.checked
                              ? [...ws.checked, asset.id]
                              : ws.checked.filter((value) => value !== asset.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <div className="assets-host-line">
                        <span className="assets-host mono">{asset.hostname}</span>
                        {asset.seed && <span className="tag">种子</span>}
                      </div>
                      {latest && (
                        <div className="assets-evidence">
                          <span className="cell-sub">{evidence.length} 份证据</span>
                          <span className="assets-evidence-link">{ws.linkEvidence([latest.id])}</span>
                        </div>
                      )}
                    </td>
                    <td className="assets-source" title={asset.source || undefined}>
                      {asset.source || "—"}
                    </td>
                    <td className="assets-status">
                      <StatusPill value={asset.approval} label={approvalLabels[asset.approval]} />
                    </td>
                    <td className="assets-cooled-cell">
                      {asset.cooldown_override === "cooled" ? (
                        <span className="assets-cooled" title={asset.cool_reason || "人工冷处理"}>
                          <Snowflake size={11} aria-hidden="true" />
                          冷处理
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="assets-created mono">{fmt(asset.created_at)}</td>
                    <td className="assets-col-actions">
                      <div className="assets-actions">
                        {asset.approval === "pending" && (
                          <button
                            type="button"
                            className="button small"
                            disabled={ws.busy}
                            onClick={() => void approve([asset.id])}
                          >
                            批准测试
                          </button>
                        )}
                        {asset.approval === "approved" && (
                          <>
                            <span className="assets-run-state" data-active={isExploring(asset.id)}>
                              {isExploring(asset.id) ? "探索中" : "待探索"}
                            </span>
                            <button
                              type="button"
                              className="button small danger subtle"
                              disabled={ws.busy}
                              onClick={() => setRevoking(asset)}
                            >
                              撤销批准
                            </button>
                            {asset.cooldown_override === "cooled" ? (
                              <button
                                type="button"
                                className="button small ghost"
                                disabled={ws.busy}
                                onClick={() => void setInterest(asset, "auto")}
                              >
                                恢复关注
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="button small ghost"
                                disabled={ws.busy}
                                onClick={() => {
                                  setReason("");
                                  setCooling(asset);
                                }}
                              >
                                冷处理
                              </button>
                            )}
                          </>
                        )}
                        {asset.approval === "rejected" && (
                          <span className="assets-run-state muted">不在范围内</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {revoking && (
        <Modal
          label="撤销批准"
          title="撤销批准"
          busy={ws.busy}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button
                type="button"
                className="button"
                disabled={ws.busy}
                onClick={() => setRevoking(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button danger"
                disabled={ws.busy}
                onClick={() => void revoke(revoking)}
              >
                撤销批准
              </button>
            </>
          }
        >
          <p className="assets-modal-lead">
            <span className="mono">{revoking.hostname}</span> 将退出测试范围。
          </p>
          <p className="quiet">
            这是范围变更：该资产会退回待批准，未完成的任务被取消，之后的探索不再触碰它。已产生的证据、事实与结论保留，重新批准后可继续。
          </p>
        </Modal>
      )}

      {cooling && (
        <Modal
          label="冷处理资产"
          title="冷处理资产"
          busy={ws.busy}
          onClose={() => setCooling(null)}
          footer={
            <>
              <button
                type="button"
                className="button"
                disabled={ws.busy}
                onClick={() => setCooling(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button primary"
                disabled={ws.busy}
                onClick={() =>
                  void setInterest(cooling, "cooled", reason.trim()).then((ok) => {
                    if (ok) setCooling(null);
                  })
                }
              >
                确认冷处理
              </button>
            </>
          }
        >
          <p className="assets-modal-lead">
            暂时不让规划触碰 <span className="mono">{cooling.hostname}</span>。
          </p>
          <p className="quiet">冷处理不改批准状态：范围仍是已批准，只是把它从规划入口移开，随时可以恢复关注。</p>
          <label className="field">
            <span className="field-label">理由（可选）</span>
            <textarea
              rows={3}
              value={reason}
              maxLength={300}
              placeholder="为什么暂时不碰它，供同事与模型参考"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </Modal>
      )}
    </section>
  );
}
