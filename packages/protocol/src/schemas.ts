import { z } from "zod";
import { TEST_DOMAINS } from "./domains.js";

export const MAX_TEXT_LENGTH = 65536;
export const MAX_EVIDENCE_CONTENT = 20_000_000;
export const bookmarkInputSchema = z
  .object({
    worker: z.string().trim().min(1).max(128),
    node_id: z.string().trim().min(1).max(128),
    expected_version: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(1000).optional(),
    revisit_when: z.string().trim().min(1).max(1000).optional(),
    withdraw: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.withdraw || (!!v.reason && !!v.revisit_when), "Active bookmarks require reason and revisit_when");
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
/** 测试域枚举与中文说法在 domains.ts（无 zod 依赖，前端可安全引用）。 */
export const testDomainSchema = z.enum(TEST_DOMAINS);
/** 域内细节，≤20 字；后渗透使用「提权：SUID」这类固定前缀。 */
export const stepFocusSchema = z.string().trim().min(1).max(20);
/** A Fact's conclusion is its own field: required, complete and never truncated by projections. */
export const MAX_CONCLUSION_LENGTH = 120;
export const factStatusSchema = z.enum(["observed", "not_observed", "disputed"]);
/** Negative conclusions must say which request was made and where each parameter came from. */
export const factRequestSchema = z.object({ method: text, url: text }).strict();
export const parameterSourceSchema = z
  .object({
    parameter: text,
    /** Page JS, AJAX, meta tag, form field, documented API or an explicit guess. */
    source: text,
    evidence_ids: z.array(text).default([]),
  })
  .strict();
export const conclusionSchema = z.string().trim().min(1).max(MAX_CONCLUSION_LENGTH);
/** Application evidence for each claimed CVSS impact; not an extra CVSS metric. */
export const impactEvidenceSchema = z
  .object({
    metric: z.enum(["VC", "VI", "VA", "SC", "SI", "SA"]),
    affected: text,
    boundary: text,
    consequence: text,
    evidence_ids: z.array(text).min(1),
  })
  .strict();
/** Findings store the vector plus the score the application computed from it. */
export const cvssSchema = z
  .object({
    version: z.literal("4.0"),
    vector: text,
    score: z.number().min(0).max(10),
    rationale: text,
    impact_evidence: z.array(impactEvidenceSchema).optional(),
  })
  .strict();
export const cvssInputSchema = z
  .object({
    vector: text,
    rationale: text,
    impact_evidence: z.array(impactEvidenceSchema).optional(),
  })
  .strict();
export const hintSchema = z
  .object({ content: text, creator: text.default("human"), priority: z.number().int().default(0) })
  .strict();
export const hintUpdateSchema = z
  .object({ content: text.optional(), priority: z.number().int().optional(), step_ids: z.array(text).optional() })
  .strict();
/** Operator-only: a Hint is closed by a human, never by a model note. */
export const hintResolveSchema = z.object({ note: text.optional(), by: text.default("human") }).strict();
export const createProjectSchema = z
  .object({
    title: text,
    origin: text,
    goal: text,
    hints: z.array(hintSchema).default([]),
  })
  .strict();
export const findingIdentitySchema = z
  .object({
    category: text,
    host: text,
    protocol: text.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    method: text.optional(),
    path: text.optional(),
    location: text.optional(),
    parameter: text.optional(),
    source_role: text.optional(),
    target_role: text.optional(),
    variant: text.optional(),
  })
  .strict()
  .refine((v) => !!(v.path || v.location), "Identity requires a path or location");
export const reproductionSchema = z
  .object({
    conditions: z.array(text).default([]),
    steps: z.array(text).default([]),
    expected: text.optional(),
    observed: text.optional(),
  })
  .strict();
export const findingSchema = z
  .object({
    kind: z.enum(["vulnerability", "informational"]).nullable().optional(),
    id: text.optional(),
    title: text,
    description: text,
    evidence: z.string().max(MAX_TEXT_LENGTH).optional(),
    evidence_ids: z.array(text).max(10000).optional(),
    /** Exact HTTP flows (recording-proxy ids) that produced this claim. */
    traffic_ids: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
    from: z.array(text).max(10000).optional(),
    status: z.enum(["candidate", "confirmed", "rejected"]).optional(),
    asset_id: text.optional(),
    severity: z.enum(["critical", "high", "medium", "low", "informational"]).nullable().optional(),
    severity_reason: text.nullable().optional(),
    impact: text.nullable().optional(),
    reproduction: reproductionSchema.nullable().optional(),
    remediation: text.nullable().optional(),
    identity: findingIdentitySchema.nullable().optional(),
    /** The reviewer supplies the vector and rationale; the application computes `score`. */
    cvss: cvssInputSchema.nullable().optional(),
  })
  .strict();
export const findingActionSchema = z
  .object({
    action: z.enum(["delete", "return", "retest", "review"]),
    expected_version: z.number().int().positive(),
    creator: text,
    reason: text,
  })
  .strict();
/** Bulk re-review of exempt informational findings; at most 50 per request. */
export const reviewRequestSchema = z
  .object({
    finding_ids: z.array(text).max(50).optional(),
    all_exempt: z.boolean().default(false),
    creator: text,
    reason: text,
  })
  .strict();
/** Operator approval of one Finding version; approval leaves every pending queue. */
export const findingApprovalSchema = z
  .object({
    approved: z.boolean(),
    expected_version: z.number().int().positive(),
    creator: text,
    reason: z.string().max(2000).optional(),
  })
  .strict();
/**
 * A lead is an actionable next question, not a confirmed observation. Decide
 * must convert each open lead into a Step's lead_ids or waive it with a reason
 * before the project can complete.
 */
export const leadSubmissionSchema = z
  .object({
    surface: text,
    parameter: text.optional(),
    why: text,
    suggested_property: text,
    evidence_ids: z.array(text).default([]),
  })
  .strict();
export const nodeDeletionSchema = z
  .object({
    id: text,
    reason: text,
    cascade: z
      .enum(["none", "downstream"])
      .default("none")
      .describe(
        "downstream removes every reachable dependent, including descendants with other retained sources; none removes only the listed ID",
      ),
  })
  .strict();
/**
 * Completion evidence for one observed host+path. `tested` requires at least one
 * raw evidence ID; `waived` requires a reason. The surface is normalized before
 * comparison, so absolute URLs and origin-relative paths describe the same entry.
 */
export const coverageEntrySchema = z
  .object({
    surface: text,
    parameter: text.optional(),
    status: z.enum(["tested", "waived", "na"]),
    reason: text.optional(),
    evidence_ids: z.array(text).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "tested" && !value.evidence_ids.length)
      ctx.addIssue({ code: "custom", message: "tested coverage requires at least one evidence_ids entry" });
    if (value.status === "waived" && !value.reason?.trim())
      ctx.addIssue({ code: "custom", message: "waived coverage requires a reason" });
  });
export const deletionPreviewSchema = z.object({ delete_nodes: z.array(nodeDeletionSchema).min(1) }).strict();
/**
 * Completion accounting for one Review planning issue. The issue is identified
 * by its review and zero-based position because planning_issues are plain text.
 */
export const reviewIssueDispositionSchema = z
  .object({
    review_id: text,
    issue_index: z.number().int().nonnegative(),
    status: z.enum(["addressed", "waived"]),
    step_id: text.optional(),
    reason: text.optional(),
    evidence_ids: z.array(text).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "addressed" && !value.step_id)
      ctx.addIssue({ code: "custom", message: "addressed review issue requires the Step that executed the follow-up" });
    if (value.status === "waived" && !value.reason)
      ctx.addIssue({ code: "custom", message: "waived review issue requires a reason" });
    if (value.status === "waived" && value.step_id)
      ctx.addIssue({ code: "custom", message: "a waived review issue cannot also name a Step" });
  });
/** Operator-only: a high-risk Review issue may only be dismissed by a human. */
export const reviewIssueWaiverSchema = z.object({ reason: text, by: text.default("human") }).strict();
const decisionFields = {
  worker: text,
  revision: z.number().int().nonnegative(),
  observation_revision: z.number().int().nonnegative(),
  planning_revision: z.number().int().nonnegative().optional(),
  graph_id: text.default("main"),
  delete_nodes: z.array(nodeDeletionSchema).default([]),
  /** Optional for existing API clients; Runner supplies the hash of the preview actually returned to Decide. */
  deletion_preview_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  steps: z
    .array(
      z.object({
        from: z.array(text).min(1),
        description: text,
        /** One falsifiable security property, not merely an activity list. */
        property: text.optional(),
        method_hint: text.optional(),
        /** 测试域：固定枚举，不确定选 other；站点细节写 focus，不新造顶层分类。 */
        test_domain: testDomainSchema
          .optional()
          .describe(
            "测试域：recon 资产/信息搜集，entry 入口/前端，auth 认证/会话，access 授权，inject 注入，file 文件，config 配置/传输，logic 业务逻辑，post 后渗透，other 其他",
          ),
        focus: stepFocusSchema.optional().describe("可选，域内细节，如 提权：SUID"),
        priority: z.number().int().default(0),
        asset_id: text.optional(),
        goal_id: text.optional(),
        hint_ids: z.array(text).optional(),
        lead_ids: z.array(text).optional(),
      }),
    )
    .default([]),
  updates: z
    .array(
      z.object({
        id: text,
        priority: z.number().int().optional(),
        test_domain: testDomainSchema.optional(),
        focus: stepFocusSchema.optional(),
        discard: z.boolean().default(false),
        reason: text.optional(),
        expected_version: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  reopens: z
    .array(z.object({ id: text, reason: text, expected_version: z.number().int().positive().optional() }))
    .default([]),
  finding_merges: z
    .array(
      z
        .object({
          target_id: text,
          source_ids: z.array(text).min(1),
          expected_versions: z.record(z.string(), z.number().int().positive()),
          reason: text,
        })
        .strict(),
    )
    .default([]),
  finding_updates: z
    .array(
      z
        .object({
          id: text,
          expected_version: z.number().int().positive(),
          reason: text,
          withdraw: z.boolean().default(false),
          restore: z.boolean().optional(),
          changes: findingSchema
            .pick({
              title: true,
              description: true,
              evidence: true,
              evidence_ids: true,
              from: true,
              kind: true,
              impact: true,
              reproduction: true,
              remediation: true,
              identity: true,
            })
            .partial()
            .default({}),
        })
        .strict()
        .refine((v) => !(v.withdraw && v.restore), "Cannot withdraw and restore together")
        .refine((v) => v.withdraw || v.restore || Object.keys(v.changes).length > 0, "Finding changes cannot be empty"),
    )
    .default([]),
  /**
   * 资产冷处理：只影响「是否出现在下一轮规划入口」，不改批准状态。
   * 撤销批准始终是人的动作——模型可以不再规划某台主机，但不能替人收回授权。
   */
  assets: z
    .array(
      z.object({
        id: text,
        state: z.enum(["auto", "cooled"]),
        reason: text.optional(),
        revisit_when: text.optional(),
      }),
    )
    .default([]),
  closes: z
    .array(
      z.object({
        id: text,
        reason: text,
        evidence_ids: z.array(text).default([]),
        expected_version: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  goals: z
    .array(
      z
        .object({
          id: text.optional(),
          description: text,
          state: z.enum(["active", "satisfied", "withdrawn"]).default("active"),
        })
        .refine((v) => v.id !== "goal", "Use complete for the root goal; omit root goal from goals"),
    )
    .default([]),
  /**
   * A Hint is a human directive: every active Hint must either be carried by a
   * Step's `hint_ids` or explained here. A note is recorded on the Hint and
   * blocks nothing else; an unanswered Hint blocks `complete`.
   */
  hint_notes: z.array(z.object({ id: text, note: text })).default([]),
  /**
   * Resolve a Lead. New Steps carry `lead_ids` directly; this field is for
   * waiving a lead with a reason or attaching it to an existing Step.
   */
  lead_dispositions: z
    .array(
      z
        .object({
          lead_id: text,
          step_id: text.optional(),
          waiver_reason: text.optional(),
        })
        .strict()
        .refine(
          (v) => !(v.step_id && v.waiver_reason),
          "A lead disposition is either converted to a Step or waived, not both",
        ),
    )
    .default([]),
  complete: z
    .object({
      from: z.array(text).min(1),
      description: text,
      /**
       * Every host+path surface observed in the graph must be accounted for
       * before the search can be declared complete.
       */
      coverage: z.array(coverageEntrySchema).default([]),
      /**
       * Every open Review planning issue must be accounted for before completion:
       * addressed by an executed Step, or waived with a reason (high-risk issues
       * also need an operator waiver recorded on the Review).
       */
      review_issues: z.array(reviewIssueDispositionSchema).default([]),
    })
    .optional(),
};
const decisionRules = (v: { complete?: unknown; steps: unknown[] }) => !v.complete || !v.steps.length;
const uniqueStepMutations = (v: { updates: { id: string }[]; closes: { id: string }[]; reopens: { id: string }[] }) => {
  const ids = [...v.updates, ...v.closes, ...v.reopens].map((item) => item.id);
  return new Set(ids).size === ids.length;
};
const uniqueFindingMerges = (v: {
  finding_merges: { target_id: string; source_ids: string[] }[];
  finding_updates: { id: string }[];
}) => {
  const ids = [
    ...v.finding_merges.flatMap((m) => [m.target_id, ...m.source_ids]),
    ...v.finding_updates.map((u) => u.id),
  ];
  return new Set(ids).size === ids.length;
};
export const decideSchema = z
  .object(decisionFields)
  .strict()
  .refine(decisionRules, "Plan new steps or complete; do not create unfinished steps while completing")
  .refine(uniqueStepMutations, "Each Step can have only one update, close or reopen per decision batch")
  .refine(
    uniqueFindingMerges,
    "Each Finding can occur only once in a merge batch; self-merges and chains are not allowed",
  );
/**
 * The only Decide write contract exposed to the model. Plan (new Steps) and settle
 * (priority/close/reopen/complete) are separate transactions inside the store, but the
 * caller sees one call, one idempotency key and one response with both outcomes.
 */
export const submitDecisionsBase = z
  .object({
    submission_id: text.max(128),
    plan_id: text.optional(),
    /**
     * Settle one part of a larger decision and keep the Decide lease open for
     * the next part. The runner sets this automatically when it splits an
     * oversized batch; a model may set it to submit plan/step settlement and
     * Finding revisions in bounded calls instead of one maximum-size payload.
     * A completion is always final and cannot carry `more`.
     */
    more: z.boolean().default(false),
    ...decisionFields,
  })
  .strict();
export const submitDecisionsSchema = submitDecisionsBase
  .refine(decisionRules, "Plan new steps or complete; do not create unfinished steps while completing")
  .refine(uniqueStepMutations, "Each Step can have only one update, close or reopen per decision batch")
  .refine(
    uniqueFindingMerges,
    "Each Finding can occur only once in a merge batch; self-merges and chains are not allowed",
  )
  .refine(
    (value) => !(value.more && value.complete),
    "A completion ends the Decide run; omit more or send complete in the final part",
  );
/**
 * One observation written through the incremental endpoint. The model-facing
 * tool, that endpoint and the final execute payload describe the same thing, so
 * they must agree on which fields exist: an id in `description`, or an extra
 * `from`, is a reference to a node that already exists, not a new fact.
 */
export const factSubmissionSchema = z
  .object({
    description: text,
    conclusion: conclusionSchema.optional(),
    status: factStatusSchema.optional(),
    objects: z.array(text).max(200).optional(),
    request: factRequestSchema.optional(),
    parameter_sources: z.array(parameterSourceSchema).max(100).optional(),
    evidence_ids: z.array(text).default([]),
  })
  .strict();
export const executeSchema = z
  .object({
    worker: text,
    facts: z
      .array(
        z.union([
          text,
          z.object({
            description: text,
            conclusion: conclusionSchema.optional(),
            status: factStatusSchema.optional(),
            objects: z.array(text).max(200).optional(),
            request: factRequestSchema.optional(),
            parameter_sources: z.array(parameterSourceSchema).max(100).optional(),
            evidence_ids: z.array(text).default([]),
          }),
        ]),
      )
      .default([]),
    findings: z.array(findingSchema).default([]),
    /** Concrete next questions discovered while working; max 20 per Run. */
    leads: z.array(leadSubmissionSchema).max(20).default([]),
    summary: z.string().max(MAX_TEXT_LENGTH).default(""),
    /** Set only by operator recovery: record the summary without marking the Step executed. */
    read_only: z.boolean().default(false),
  })
  .strict();
export const reviewSchema = z
  .object({
    planning_issues: z
      .array(text)
      .max(100)
      .optional()
      .describe("Explicit new questions requiring Decide; ordinary pass leaves this empty"),
    kind: z
      .enum(["vulnerability", "informational"])
      .nullable()
      .optional()
      .describe(
        "Passing reviews must explicitly choose vulnerability or informational; informational has no severity or CVSS",
      ),
    worker: text,
    finding_version: z.number().int().positive(),
    verdict: z.enum(["pass", "needs_evidence", "rejected"]),
    reason: text,
    evidence_ids: z.array(text).default([]),
    disputed_fact_ids: z.array(text).default([]),
    verification: text.optional(),
    severity: z.enum(["critical", "high", "medium", "low", "informational"]).nullable().optional(),
    severity_reason: text.optional(),
    cvss: cvssInputSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.verdict !== "pass" || v.kind != null,
    "Passing review requires explicit kind=vulnerability or kind=informational",
  );
export const assetBatchSchema = z
  .object({
    assets: z
      .array(
        z.object({
          hostname: text,
          source: text.default("discovery"),
          evidence_ids: z.array(text).default([]),
        }),
      )
      .min(1)
      .max(10000),
  })
  .strict();
export const evidenceSchema = z
  .object({
    step_id: text.optional(),
    title: text,
    content: z.string().max(MAX_EVIDENCE_CONTENT),
    part_ids: z.array(text).max(10000).optional(),
    source_path: text.optional(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    mime_type: text.default("text/plain"),
    asset_id: text.optional(),
  })
  .strict();
