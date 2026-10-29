import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { Graph, Step, Run, decideSchema } from "../../protocol/src/index.js";

export type StepInput = Pick<Step, "from" | "description"> &
  Partial<
    Pick<
      Step,
      | "priority"
      | "asset_id"
      | "goal_id"
      | "hint_ids"
      | "lead_ids"
      | "property"
      | "method_hint"
      | "test_domain"
      | "focus"
    >
  >;

export interface DecisionContext {
  db: DatabaseSync;
  mutate<T>(id: string, kind: string, observation: boolean, fn: (graph: Graph) => T): T;
  active(graph: Graph): void;
  validateSubmission(id: string, runId: string, body: { worker?: string }, kind: "decide"): unknown;
  insertStep(
    graph: Graph,
    input: StepInput,
    creator: string,
    graphId?: string,
    archival?: boolean,
    options?: { mergeNearDuplicates?: boolean },
  ): Step;
  checkStepVersion(step: Step, expected?: number): void;
  applyAssetStates(graph: Graph, states: z.infer<typeof decideSchema>["assets"]): void;
  endRun(graph: Graph, worker: string, status: Run["status"], error?: string, runId?: string): void;
  reopen(graph: Graph, step: Step, reason: string): void;
  /** 结束 Step 时给它的 blocked Run 结案；失败记录保留，不再计入待人工处理。 */
  settleBlockedRun(graph: Graph, step: Step, by: string): void;
  sources(graph: Graph, ids: string[]): void;
  sourceHint(graph: Graph, id: string): string;
  evidenceIds(graph: Graph, ids: string[]): void;
  next(items: { id: string }[], prefix: string): string;
  /** Operator review scope: informational findings are accepted without a Review run. */
  skipInformationalReview: boolean;
  /** Planning budget; 0 means unlimited. Enforced while a plan is committed. */
  stepBudget: { maxNewStepsPerRound: number; maxOpenSteps: number };
}

export interface SettleConflict {
  kind:
    | "lease"
    | "snapshot"
    | "update"
    | "close"
    | "reopen"
    | "goal"
    | "asset"
    | "hint"
    | "lead"
    | "complete"
    | "finding_merge"
    | "finding_update"
    | "delete";
  id?: string;
  reason: string;
}

export interface DecisionPlanResult {
  plan_id: string;
  steps: string[];
  graph_id: string;
  revision: number;
  committed: boolean;
  reused: boolean;
  /** Soft, non-blocking quality warnings for the plan that was just committed. */
  warnings?: string[];
}

export interface SettleResult {
  ok: boolean;
  conflicts: SettleConflict[];
  closed: string[];
  reopened: string[];
  updated: string[];
  completed: boolean;
  deleted: string[];
  affected: string[];
  cancelled_runs: string[];
  /** This part was accepted without ending the Decide lease (see `more`). */
  more?: boolean;
}

export interface DecisionResponse {
  plan_id: string;
  plan: DecisionPlanResult;
  settle: SettleResult;
}
