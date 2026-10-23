import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Provision once on a shared persistent directory. Never return this in public configuration. */
export function internalToken(file = process.env.TESSERA_TOKEN_FILE || ".tessera/internal-token"): string {
  const configured = process.env.TESSERA_WORKER_TOKEN?.trim();
  if (configured) return configured;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const saved = readFileSync(file, "utf8").trim();
  if (!saved) throw new Error("Internal worker credential file is empty");
  return saved;
}

/** A container capability scoped to one project; the dispatcher derives it from the global token. */
export function projectToken(global: string, projectId: string): string {
  return createHmac("sha256", global).update(projectId).digest("hex");
}

/** A distinct capability, revoked as soon as its Run loses the lease. */
export function modelRunToken(global: string, projectId: string, runId: string): string {
  return createHmac("sha256", global).update(JSON.stringify(["model-relay", projectId, runId])).digest("hex");
}

export function validInternalToken(expected: string, supplied: unknown): boolean {
  if (!expected || typeof supplied !== "string" || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
