import type { Lead, Step } from "../../../../packages/protocol/src/index.js";
import { fmt } from "../format.js";
import { prettyText } from "../text.js";
import { locateRecord, useWorkspace } from "../workspace.js";

const LEAD_LABEL: Record<Lead["status"], string> = {
  open: "待处置",
  converted: "已转任务",
  waived: "已豁免",
};

/**
 * Open leads are completion blockers, so the surface, question and suggested
 * property must be readable without opening raw submissions. Disposed leads
 * keep their waiver reason and the Step that answered them.
 */
export function LeadList({ leads, steps }: { leads: Lead[]; steps: Step[] }) {
  const ws = useWorkspace();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const open = leads.filter((lead) => lead.status === "open");
  const converted = leads.filter((lead) => lead.status === "converted");
  const waived = leads.filter((lead) => lead.status === "waived");
  return (
    <div className="lead-ledger">
      {open.length > 0 ? (
        open.map((lead) => <LeadRow key={lead.id} lead={lead} steps={byId} />)
      ) : (
        <p className="quiet">没有待处置的线索。</p>
      )}
      {open.length === 0 && waived.length + converted.length === 0 && (
        <p className="quiet">模型还没有从执行中提出后续问题。</p>
      )}
      {converted.length + waived.length > 0 && (
        <details className="lead-disposed">
          <summary>
            已处置 {converted.length + waived.length} 条{converted.length ? ` · 转任务 ${converted.length}` : ""}
            {waived.length ? ` · 豁免 ${waived.length}` : ""}
          </summary>
          <div className="lead-disposed-list">
            {[...waived, ...converted].map((lead) => (
              <LeadRow key={lead.id} lead={lead} steps={byId} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function LeadRow({ lead, steps }: { lead: Lead; steps: Map<string, Step> }) {
  const ws = useWorkspace();
  const convertedStep = lead.converted_step_id ? steps.get(lead.converted_step_id) : undefined;
  return (
    <article className="lead-row" data-status={lead.status}>
      <header className="lead-row-head">
        <span className="lead-surface mono">{lead.surface}</span>
        {lead.parameter && (
          <span className="lead-parameter">
            参数 <b className="mono">{lead.parameter}</b>
          </span>
        )}
        <span className="lead-state" data-status={lead.status}>
          {LEAD_LABEL[lead.status]}
        </span>
        <span className="quiet mono lead-id">{lead.id}</span>
      </header>
      <p className="lead-why">{prettyText(lead.why)}</p>
      <p className="lead-property">
        <span>建议验收属性</span>
        {prettyText(lead.suggested_property)}
      </p>
      {lead.status === "waived" && (
        <p className="lead-waiver">
          豁免理由：{prettyText(lead.waiver_reason) || "未记录理由"}
          {lead.disposition_at ? ` · ${fmt(lead.disposition_at)}` : ""}
        </p>
      )}
      {lead.status === "converted" && (
        <p className="lead-converted">
          已转为任务{" "}
          {lead.converted_step_id && convertedStep ? (
            <button
              type="button"
              className="inline-toggle mono"
              onClick={() => locateRecord(ws, lead.converted_step_id!)}
            >
              {lead.converted_step_id}
            </button>
          ) : (
            <span className="mono">{lead.converted_step_id || "未记录"}</span>
          )}
          {convertedStep?.property ? `：${prettyText(convertedStep.property)}` : ""}
        </p>
      )}
      <footer className="lead-row-foot">
        {lead.step_id && (
          <button type="button" className="button ghost small" onClick={() => locateRecord(ws, lead.step_id!)}>
            来源任务 {lead.step_id}
          </button>
        )}
        {lead.evidence_ids.length > 0 && (
          <span className="lead-evidence">
            {ws.linkEvidence(lead.evidence_ids.slice(0, 2))}
            {lead.evidence_ids.length > 2 && <span className="quiet">+{lead.evidence_ids.length - 2}</span>}
          </span>
        )}
        <time className="quiet" dateTime={lead.created_at}>
          {fmt(lead.created_at)}
        </time>
      </footer>
    </article>
  );
}
