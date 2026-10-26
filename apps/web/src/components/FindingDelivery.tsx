import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileText, GitCompare, X } from "lucide-react";
import { api, path } from "../api.js";
import { fmt } from "../format.js";
import { locateRecord, useWorkspace } from "../workspace.js";
import type { ReportSnapshot } from "../../../../packages/core/src/reports.js";
import { ReportPreview } from "./ReportPreview.js";
import { Card, EmptyState } from "./ui.js";
import { missingReportFields } from "../../../../packages/protocol/src/report-quality.js";
import { confirmedVulnerability } from "../project-activity.js";

interface ReportRow {
  id: string;
  created_at: string;
  source_hash: string;
  stale: boolean;
  finding_count: number;
  evidence_count: number;
  incomplete_count: number;
}
interface Duplicate {
  fingerprint: string;
  finding_ids: string[];
  match?: "endpoint";
}

export function FindingDuplicates() {
  const ws = useWorkspace();
  const [groups, setGroups] = useState<Duplicate[]>([]);
  const revision = ws.graph!.findings.map((finding) => `${finding.id}:${finding.version}:${finding.status}`).join("|");
  useEffect(() => {
    let active = true;
    void api<Duplicate[]>(path(ws.id!, "/findings/duplicates"))
      .then((result) => {
        if (active) setGroups(result);
      })
      .catch(() => {
        if (active) setGroups([]);
      });
    return () => {
      active = false;
    };
  }, [ws.id, revision]);
  if (!groups.length) return null;
  return (
    <details className="card duplicates-panel">
      <summary className="card-head duplicates-summary">
        <span className="card-head-main">
          <span className="card-icon">
            <GitCompare size={14} />
          </span>
          <h2>重复与关联候选</h2>
          <span className="card-note">{groups.length} 组需要核对</span>
        </span>
        <span className="duplicates-hint">
          核对明细
          <ChevronDown size={14} className="duplicates-chevron" />
        </span>
      </summary>
      <div className="card-body">
        <p className="quiet card-lede">
          相同身份是重复候选；同一入口的不同问题是关联候选。决策者核对根因、修复方式与独立影响后决定合并，目标新版本重新审核，原文和历史保留。未授权泄露与
          CORS 不仅凭同一接口合并，须核对是否增加了实际影响。
        </p>
        {groups.map((group) => (
          <div className="duplicate-row" key={group.fingerprint}>
            <span className="quiet">{group.match === "endpoint" ? "同一入口 · 待核对关联" : "相同身份 · 待去重"}</span>
            <div className="duplicate-ids">
              {group.finding_ids.map((id) => (
                <button type="button" key={id} className="button small" onClick={() => locateRecord(ws, id)}>
                  {id}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export function FindingReports({ variant = "card" }: { variant?: "card" | "menu" } = {}) {
  const ws = useWorkspace();
  const id = ws.id!;
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [error, setError] = useState("");
  const creating = useRef(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<ReportSnapshot | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const incomplete = ws.graph!.findings.filter(
    (finding) => confirmedVulnerability(finding) && missingReportFields(finding).length,
  ).length;

  useEffect(() => {
    let active = true;
    void api<ReportRow[]>(path(id, "/reports"))
      .then((result) => {
        if (active) {
          setRows(result);
          setError("");
        }
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : "报告读取失败");
      });
    return () => {
      active = false;
    };
  }, [id, ws.graph?.revision]);

  useEffect(() => {
    request.current++;
    setPreview(null);
    setOpenMenu(false);
    return () => {
      request.current++;
    };
  }, [id]);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  async function openReport(reportId: string) {
    const seq = ++request.current;
    try {
      const result = await api<ReportSnapshot>(path(id, `/reports/${reportId}`));
      if (seq === request.current) {
        setPreview(result);
        setOpenMenu(false);
        setError("");
      }
    } catch (failure) {
      if (seq === request.current) setError(failure instanceof Error ? failure.message : "报告读取失败");
    }
  }

  async function create() {
    if (creating.current) return;
    creating.current = true;
    setGenerating(true);
    try {
      await ws.action(async () => {
        await api(path(id, "/reports"), {});
        setRows(await api<ReportRow[]>(path(id, "/reports")));
        setError("");
      });
    } finally {
      creating.current = false;
      setGenerating(false);
    }
  }

  const list = (
    <div className="report-list">
      {error && <p className="banner danger">{error}</p>}
      {!!incomplete && (
        <p className="evidence-note">
          当前已确认漏洞中有 {incomplete} 项字段不全，生成报告前请补齐影响描述、复现步骤和修复建议。
        </p>
      )}
      {!rows.length && !error && (
        <EmptyState compact title="尚无报告快照" desc="生成后会冻结风险、复现、审核与证据索引。" />
      )}
      {rows.map((row) => (
        <div className="report-row" key={row.id}>
          <div className="report-main">
            <strong>{fmt(row.created_at)}</strong>
            <small>
              {row.finding_count} 项发现 · {row.evidence_count} 份证据 ·{" "}
              <span>{row.stale ? "输入已变化，快照过期" : "当前快照"}</span>
              {!!row.incomplete_count && <span> · {row.incomplete_count} 项字段不全</span>}
            </small>
            <span className="mono quiet">{row.id}</span>
          </div>
          <div className="report-actions">
            <button type="button" className="button small" onClick={() => void openReport(row.id)}>
              预览
            </button>
            <a className="button small ghost" href={"/api" + path(id, `/reports/${row.id}/content?format=markdown`)}>
              <Download size={12} />
              Markdown
            </a>
            <a className="button small ghost" href={"/api" + path(id, `/reports/${row.id}/content?format=zip`)}>
              <Download size={12} />
              ZIP
            </a>
          </div>
        </div>
      ))}
    </div>
  );

  const previewNode = preview ? (
    <ReportPreview
      report={preview}
      stale={rows.find((row) => row.id === preview.id)?.stale ?? true}
      onClose={() => {
        request.current++;
        setPreview(null);
      }}
    />
  ) : null;

  if (variant === "menu") {
    return (
      <div className="report-menu" ref={menuRef}>
        <button
          type="button"
          className={`button report-trigger${openMenu ? " active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu}
          onClick={() => setOpenMenu((value) => !value)}
        >
          <FileText size={14} />
          报告
          {rows.length ? <span className="report-count">{rows.length}</span> : null}
        </button>
        {openMenu && (
          <div className="report-popover" role="dialog" aria-label="报告快照">
            <header className="report-popover-head">
              <div>
                <strong>报告快照</strong>
                <small>只包含当前版本已通过审核的发现</small>
              </div>
              <div className="report-popover-actions">
                <button
                  type="button"
                  className="button small primary"
                  disabled={ws.busy || generating}
                  onClick={() => void create()}
                >
                  {generating ? "正在生成…" : "生成报告"}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭报告列表"
                  onClick={() => setOpenMenu(false)}
                >
                  <X size={14} />
                </button>
              </div>
            </header>
            {list}
          </div>
        )}
        {previewNode}
      </div>
    );
  }

  return (
    <Card
      title="报告交付"
      icon={<FileText size={14} />}
      note="只包含当前版本已通过审核的发现"
      actions={
        <button
          type="button"
          className="button small primary"
          disabled={ws.busy || generating}
          onClick={() => void create()}
        >
          {generating ? "正在生成…" : "生成报告快照"}
        </button>
      }
    >
      {list}
      {previewNode}
    </Card>
  );
}
