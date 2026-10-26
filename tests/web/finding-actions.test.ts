import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingActions } from "../../apps/web/src/components/FindingActions.js";
import { FindingDetails } from "../../apps/web/src/components/FindingDetails.js";
import { WorkspaceContext, type Workspace } from "../../apps/web/src/workspace.js";
import { reportSnapshot } from "../fixtures/report.js";

test("post-Review actions appear on the Finding page while default graph details have no operator actions", () => {
  const report = reportSnapshot(),
    finding = report.material.findings[0];
  const ws = {
    id: report.project_id,
    busy: false,
    graph: { ...report.material, steps: [], project: { status: "active" }, reviews: report.material.reviews },
    linkEvidence: () => null,
  } as unknown as Workspace;
  const render = (component: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: ws }, component));
  const actions = render(createElement(FindingActions, { finding }));
  for (const label of ["删除", "打回", "重测"]) assert.ok(actions.includes(label));
  assert.ok(!render(createElement(FindingDetails, { finding })).includes('aria-label="人工处理漏洞"'));
  assert.ok(
    render(createElement(FindingDetails, { finding, allowActions: true })).includes('aria-label="人工处理漏洞"'),
  );
  ws.graph!.reviews = [];
  // Approval is independent of Review: the button stays, the post-Review actions do not.
  const unreviewed = render(createElement(FindingActions, { finding }));
  assert.ok(unreviewed.includes("批准"));
  for (const label of ["删除", "打回", "重测"]) assert.ok(!unreviewed.includes(label));
  const source = readFileSync(new URL("../../apps/web/src/WorkbenchTools.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source.slice(source.indexOf("export function QuickSidebar")), /\/manual|Confirm|Reject|人工审核/);
});
