import { isIPv4 } from "node:net";
import { z } from "zod";

const port = z.number().int().min(1).max(65535);

const ingressSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  z
    .array(
      z
        .object({
          host_port: port,
          worker_port: port,
          protocol: z.enum(["tcp", "udp"]).default("tcp"),
          bind: z.string().refine(isIPv4, "bind must be an IPv4 address").default("127.0.0.1"),
        })
        .strict(),
    )
    .max(100),
);

/**
 * Explicit per-project callback bindings, keyed by project id.
 * Rejects a host port that two projects would publish on the same protocol/address.
 */
export function ingressConfig(source = process.env.TESSERA_WORKER_INGRESS || "{}") {
  const config = ingressSchema.parse(JSON.parse(source));
  const used: { port: number; protocol: string; bind: string }[] = [];
  for (const entries of Object.values(config))
    for (const entry of entries) {
      if (
        used.some(
          (item) =>
            item.port === entry.host_port &&
            item.protocol === entry.protocol &&
            (item.bind === entry.bind || item.bind === "0.0.0.0" || entry.bind === "0.0.0.0"),
        )
      )
        throw new Error(`Duplicate callback binding: ${entry.bind}:${entry.host_port}/${entry.protocol}`);
      used.push({ port: entry.host_port, protocol: entry.protocol, bind: entry.bind });
    }
  return config;
}
