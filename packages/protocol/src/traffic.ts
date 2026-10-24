import { z } from "zod";

export const trafficMessageSchema = z
  .object({
    head: z.string(),
    body_base64: z
      .string()
      .max(349528)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .default(""),
    body_id: z.string().uuid().optional(),
    trailers: z.string().optional(),
    size: z.number().int().nonnegative(),
    truncated: z.boolean().default(false),
  })
  .strict();
export const trafficRecordSchema = z
  .object({
    capture_kind: z.enum(["http", "connection", "packet"]).default("http"),
    // connection 记录用它表达连接生命周期；packet 聚合行与 http 记录不带该字段。
    capture_state: z.enum(["open", "closed", "error"]).optional(),
    packet_count: z.number().int().nonnegative().optional(),
    last_seen: z.string().datetime().optional(),
    id: z.string().min(1).max(160),
    created_at: z.string().datetime(),
    method: z.string().max(32),
    url: z.string().max(16384),
    host: z.string().max(512),
    protocol: z.string().max(32).default("HTTP/1.1"),
    status: z.number().int().min(100).max(999).nullable().default(null),
    duration_ms: z.number().nonnegative().nullable().default(null),
    run_id: z.string().max(160).optional(),
    step_id: z.string().max(160).optional(),
    request: trafficMessageSchema,
    response: trafficMessageSchema.nullable().default(null),
    error: z.string().max(4000).optional(),
  })
  .strict();
export type TrafficRecord = z.infer<typeof trafficRecordSchema> & { seq: number; updated_at: string };
export type TrafficSummary = Omit<TrafficRecord, "request" | "response"> & {
  request_size: number;
  response_size: number;
  truncated: boolean;
};
export const trafficStatusSchema = z
  .object({
    state: z.enum(["starting", "active", "degraded", "unavailable", "stopped"]),
    blocked: z.number().int().nonnegative().default(0),
    guard: z.boolean().default(false),
    dropped: z.number().int().nonnegative().default(0),
    error: z.string().max(2000).optional(),
    /** Non-fatal hint: the upstream TLS 1.2 handshake failed after (or because of) downgrade. */
    tls_notice: z.string().max(2000).optional(),
  })
  .strict();
export type TrafficStatus = z.infer<typeof trafficStatusSchema> & { mode: "proxy"; last_seen: string | null };
