import type { FindingIdentity } from "./index.js";

export function normalizeFindingIdentity(identity: FindingIdentity): FindingIdentity {
  const protocol = identity.protocol?.trim().toLowerCase();
  return {
    category: identity.category.trim().toLowerCase().replace(/[ -]+/g, "_"),
    host: identity.host.trim().toLowerCase().replace(/\.$/, ""),
    ...(protocol ? { protocol } : {}),
    ...(identity.port === undefined ? (protocol === "https" ? { port: 443 } : protocol === "http" ? { port: 80 } : {}) : { port: identity.port }),
    ...(identity.method ? { method: identity.method.trim().toUpperCase() } : {}),
    ...Object.fromEntries(["path", "location", "parameter", "source_role", "target_role", "variant"]
      .flatMap(key => {
        const value = identity[key as keyof FindingIdentity];
        return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
      })),
  };
}
