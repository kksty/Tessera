import { z } from "zod";

/** Shared request-body primitives for the internal HTTP API. */
export const text = z.string().trim().min(1).max(65536);

export const jobSchema = z.object({
  kind: z.enum(["decide", "execute", "review", "peer"]),
  project_id: text,
  worker: text,
  graph_id: text,
  step_id: text.optional(),
  finding_id: text.optional(),
  finding_version: z.number().int().optional(),
  run_id: text.optional(),
  peer_id: text.optional(),
});
