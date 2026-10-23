import { useMemo } from "react";
import {
  ArrowUpRight,
  Bug,
  ChevronDown,
  FilterX,
  Gauge,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  fromNow,
  pct,
  severityLabels,
  severityOrder,
  type SeverityKey,
} from "../format.js";
import { Card, EmptyState, Kpi, PageHeader, Segmented, SeverityBadge } from "../components/ui.js";
import { useViewState } from "../view-state.js";
import { useWorkspace } from "../workspace.js";

const EMPTY_COUNTS = Object.fromEntries(
  severityOrder.map((key) => [key, 0]),
) as Record<SeverityKey, number>;

export function AllFindingsPage() {
  const ws = useWorkspace();
  // Filters survive a round-trip into a project, so 返回 restores both the
  // scroll position and the list the operator was reading.
  const [query, setQuery] = useViewState("workspace:vulns:query", "");
  const [severity, setSeverity] = useViewState("workspace:vulns:severity", "all");
  const [project, setProject] = useViewState("workspace:vulns:project", "all");
  const [sort, setSort] = useViewState<"risk" | "recent">("workspace:vulns:sort", "risk");
  const [collapsed, setCollapsed] = useViewState<Record<string, boolean>>(
    "workspace:vulns:collapsed",
    {},
  );

  const findings = useMemo(
    () => ws.allFindings.filter((finding) => finding.confirmed),
    [ws.allFindings],
  );
  const projects = useMemo(
    () => [...new Map(findings.map((finding) => [finding.project_id, finding.project_title])).entries()],
    [findings],
  );
  const severityCounts = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const finding of findings) {
      const key = (finding.severity || "ungraded") as SeverityKey;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [findings]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return findings
      .filter(
        (finding) =>
          (severity === "all" || (finding.severity || "ungraded") === severity) &&
          (project === "all" || finding.project_id === project) &&
          (!needle ||
            `${finding.title} ${finding.id} ${finding.project_title} ${finding.asset_hostname || ""}`
              .toLowerCase()
              .includes(needle)),
      )
      .sort((left, right) =>
        sort === "recent"
          ? right.created_at.localeCompare(left.created_at)
          : (right.cvss_score ?? -1) - (left.cvss_score ?? -1) ||
            right.created_at.localeCompare(left.created_at),
      );
  }, [findings, query, severity, project, sort]);

  const displayed = useMemo(() => filtered.slice(0, 400), [filtered]);
  const total = displayed.length;
  const groups = useMemo(
    () =>
      severityOrder
        .map((key) => ({
          key,
          items: displayed.filter((finding) => (finding.severity || "ungraded") === key),
        }))
        .filter((group) => group.items.length > 0),
    [displayed],
  );

  const highRisk = findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  ).length;
  const scoredAll = findings
    .map((finding) => finding.cvss_score)
    .filter((value): value is number => typeof value === "number");
  const avgCvss = scoredAll.length
    ? scoredAll.reduce((sum, value) => sum + value, 0) / scoredAll.length
    : null;
  const dirty = !!query || severity !== "all" || project !== "all";
  const reset = () => {
    setQuery("");
    setSeverity("all");
    setProject("all");
  };
  const tabs = [
    { key: "all", label: "全部", count: findings.length },
    ...severityOrder
      .filter((key) => severityCounts[key] > 0)
      .map((key) => ({ key, label: severityLabels[key], count: severityCounts[key] })),
  ];

  return (
    <section className="page page-vulns">
      <PageHeader
        eyebrow="WORKSPACE / VULNERABILITY LIBRARY"
        title="漏洞库"
        description="当前版本审核通过、具备原始证据与有效评分的漏洞。候选、待补证与已驳回的发现留在项目的「发现」页，不进入这里。"
        actions={
          <button
            type="button"
            className="button ghost"
            onClick={() => void ws.refresh()}
            disabled={ws.overviewLoading}
          >
            <RefreshCw size={14} className={ws.overviewLoading ? "spin" : undefined} />
            刷新
          </button>
        }
      />

      <div className="kpi-grid">
        <Kpi
          label="已确认漏洞"
          value={findings.length}
          note="按当前有效版本统计"
          icon={<ShieldCheck size={15} />}
          tone={findings.length ? "accent" : "neutral"}
        />
        <Kpi
          label="严重 / 高危"
          value={highRisk}
          note="已审核的漏洞影响"
          icon={<ShieldAlert size={15} />}
          tone={highRisk ? "critical" : "neutral"}
        />
        <Kpi
          label="平均 CVSS"
          value={avgCvss === null ? "—" : avgCvss.toFixed(1)}
          note={scoredAll.length ? `${scoredAll.length} 项有有效评分` : "暂无可评分漏洞"}
          icon={<Gauge size={15} />}
        />
        <Kpi
          label="涉及项目"
          value={projects.length}
          note={`${ws.projects.length} 个项目在工作区`}
          icon={<Bug size={15} />}
        />
      </div>

      <div className="vulns-toolbar toolbar">
        <div className="severity-tabs" role="group" aria-label="按严重程度筛选">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={severity === tab.key ? "active" : ""}
              data-severity={tab.key === "all" ? undefined : tab.key}
              aria-pressed={severity === tab.key}
              onClick={() => setSeverity(tab.key)}
            >
              {tab.key !== "all" && <span className="severity-tab-dot" aria-hidden="true" />}
              <span>{tab.label}</span>
              <b>{tab.count}</b>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="search-input">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索漏洞、项目或资产…"
            aria-label="搜索漏洞"
          />
        </label>
        <select
          aria-label="按项目筛选"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          className="select-compact"
        >
          <option value="all">全部项目</option>
          {projects.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <Segmented
          ariaLabel="排序"
          size="sm"
          value={sort}
          onChange={setSort}
          options={[["risk", "按风险"], ["recent", "按时间"]] as const}
        />
        {dirty && (
          <button type="button" className="button ghost small" onClick={reset}>
            <FilterX size={13} />
            重置
          </button>
        )}
      </div>

      {total ? (
        <Card
          title={`${filtered.length} 项漏洞`}
          note={dirty ? "已按筛选条件分组" : "按严重程度分组"}
          flush
        >
          <div className="data-table-wrap plain">
            <table className="data-table vuln-table">
              <thead>
                <tr>
                  <th>漏洞</th>
                  <th>项目</th>
                  <th className="num">CVSS</th>
                  <th>发现时间</th>
                  <th aria-label="打开" />
                </tr>
              </thead>
              {groups.map((group) => {
                const closed = !!collapsed[group.key];
                return (
                  <tbody
                    key={group.key}
                    className="vuln-group"
                    data-severity={group.key}
                    data-collapsed={closed || undefined}
                  >
                    <tr className="vuln-group-row">
                      <td colSpan={5}>
                        <button
                          type="button"
                          className="vuln-group-toggle"
                          aria-expanded={!closed}
                          onClick={() =>
                            setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))
                          }
                        >
                          <SeverityBadge severity={group.key} />
                          <span className="vuln-group-count">{group.items.length}</span>
                          <span className="vuln-group-unit">项</span>
                          {groups.length > 1 && (
                            <>
                              <span className="vuln-group-meter" aria-hidden="true">
                                <i style={{ width: `${pct(group.items.length, total)}%` }} />
                              </span>
                              <span className="vuln-group-share">
                                {pct(group.items.length, total)}%
                              </span>
                            </>
                          )}
                          <span className="spacer" />
                          <span className="vuln-group-toggle-label">{closed ? "展开" : "收起"}</span>
                          <ChevronDown
                            size={14}
                            className={closed ? "group-chevron closed" : "group-chevron"}
                            aria-hidden="true"
                          />
                        </button>
                      </td>
                    </tr>
                    {!closed &&
                      group.items.map((finding) => (
                        <tr
                          key={`${finding.project_id}:${finding.id}`}
                          className="clickable"
                          data-confirmed="true"
                          onClick={() => ws.openFinding(finding.project_id, finding.id)}
                        >
                          <td>
                            <span className="cell-title">{finding.title}</span>
                            <span className="cell-sub mono">
                              {finding.id}
                              {finding.asset_hostname ? ` · ${finding.asset_hostname}` : ""}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="link-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                ws.openProject(finding.project_id);
                              }}
                            >
                              {finding.project_title}
                            </button>
                          </td>
                          <td className="num mono">
                            <span className="cvss-score">
                              {finding.cvss_score?.toFixed(1) ?? "—"}
                            </span>
                          </td>
                          <td className="quiet nowrap">{fromNow(finding.created_at)}</td>
                          <td className="num">
                            <ArrowUpRight size={14} className="row-arrow" aria-hidden="true" />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                );
              })}
            </table>
          </div>
          {filtered.length > 400 && (
            <p className="table-footnote">仅显示前 400 项，请用筛选条件缩小范围。</p>
          )}
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={<Bug size={20} />}
            title={findings.length ? "没有符合筛选条件的漏洞" : "还没有已确认漏洞"}
            desc={
              findings.length
                ? "调整筛选条件或重置筛选。"
                : "在项目的「发现」中查看候选、信息类和审核记录。"
            }
            action={
              dirty ? (
                <button type="button" className="button" onClick={reset}>
                  重置筛选
                </button>
              ) : undefined
            }
          />
        </Card>
      )}
    </section>
  );
}
