import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The worker token is visible inside every project container, so it cannot be the
 * capability for workspace files: a model in project A could otherwise read or
 * delete project B's workspace. The server signs the project id with a secret that
 * only the server and dispatcher share through the data volume; the worker never
 * sees it.
 */
export function workspaceSecretFile(dataDir: string) {
  return process.env.TESSERA_WORKSPACE_SECRET_FILE || join(dataDir, "workspace-secret");
}

export function readWorkspaceSecret(dataDir: string) {
  const file = workspaceSecretFile(dataDir);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(file, "utf8").trim();
    throw error;
  }
}

export function workspaceSignature(secret: string, projectId: string) {
  return createHmac("sha256", secret).update(projectId).digest("base64url");
}
