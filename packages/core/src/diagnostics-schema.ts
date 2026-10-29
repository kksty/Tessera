import { z } from "zod";

export declare const __TESSERA_BUILD_INFO__: { id: string; version: string; pi_sdk: string };

export const diagnosticBuild =
  typeof __TESSERA_BUILD_INFO__ === "undefined"
    ? { id: "source_unbundled", version: "unknown", pi_sdk: "unknown" }
    : __TESSERA_BUILD_INFO__;

export const diagnosticSchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    source_id: z.string().uuid().optional(),
    source_seq: z.number().int().positive().optional(),
    type: z.enum([
      "run_start",
      "run_end",
      "model_start",
      "model_end",
      "model_request_payload",
      "model_response",
      "model_request_end",
      "model_request_error",
      "model_capture_error",
      "tool_start",
      "tool_end",
      "tool_protocol_mismatch",
      "tool_excerpt",
      "tool_blocked",
      "closeout",
      "result_repair",
      "capacity_plan",
      "context_usage",
      "compaction_start",
      "compaction_end",
      "compaction_anchor",
      "compaction_anchor_failed",
      "validation_trace",
      "validation_trace_limit",
      "result_validation",
      "submission",
      "decision_submission",
      "decision_batch_split",
      "fact_payload_filtered",
      "heartbeat_retry",
    ]),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type Diagnostic = z.infer<typeof diagnosticSchema>;

/** 每次 Run 的压缩、工具与收尾次数；来自诊断事件，不复制进 Step 或 Run 快照。 */
export interface RunCost {
  tool_calls: number;
  compactions: number;
  anchors: number;
  anchor_failures: number;
  closeouts: number;
}
