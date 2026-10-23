import type { CoverageEntry, Fact, Graph } from "./models.js";

/**
 * Completion coverage is deliberately narrower than free text: it counts the
 * host+path surfaces a Fact actually recorded in `objects` or `request.url`.
 * Workspace file paths are not target surfaces. This keeps the no-coverage
 * legacy path working while making the surfaces that were observed impossible
 * to silently omit.
 */
export interface CoverageSurface {
  surface: string;
  fact_ids: string[];
  evidence_ids: string[];
  parameters: string[];
}

export interface CoverageCheck {
  surfaces: CoverageSurface[];
  /** Observed surfaces with no coverage entry. */
  missing: string[];
  /** Entries that cannot be normalized or violate the status contract. */
  invalid: string[];
}

const FS_PREFIX = /^\/(?:workspace|tmp|var|etc|root|home|mnt|proc|sys|dev|opt|usr|bin|sbin|lib|boot|run)\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function clean(value: string): string {
  return value
    .trim()
    .replace(/^[<("'`]+/, "")
    .replace(/[)>"'`,.;]+$/, "");
}

function normalizePath(path: string): string {
  let value = (path || "/").split(/[?#]/, 1)[0];
  if (!value.startsWith("/")) value = "/" + value;
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value || "/";
}

function normalizeHost(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

/** Absolute URL, protocol-relative URL, origin-relative path, or host/path. */
export function normalizeSurface(value: string, originHost = "", allowAnyHost = false): string | null {
  let raw = clean(value);
  if (!raw) return null;
  if (raw.startsWith("//")) raw = "https:" + raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    return host + normalizePath(url.pathname);
  }
  if (raw.startsWith("/")) {
    if (FS_PREFIX.test(raw)) return null;
    if (!originHost) return null;
    return normalizeHost(originHost) + normalizePath(raw);
  }
  // A bare host, port or technology tag is not a host+path surface. Port
  // inventories such as "21/tcp" or "8080/http" must not become 0.0.0.21.
  if (!raw.includes("/")) return null;
  const hostPart = raw.split("/", 1)[0];
  if (/^\d+$/.test(hostPart) || /^\d+\/[a-z]+$/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL("https://" + raw);
  } catch {
    return null;
  }
  const host = normalizeHost(url.hostname);
  // `coverageSurfaces` emits host/path strings, and the absolute-URL branch may
  // produce IPv6 literals, localhost or other single-label hosts for internally
  // reachable targets. Validation must accept the same strings it asks the model
  // to echo back; raw Fact objects keep the stricter rule to avoid turning
  // technology tags such as "nginx/1.2" into coverage requirements.
  if (!host) return null;
  if (!allowAnyHost && !host.includes(".") && !IPV4.test(host) && !host.startsWith("[") && host !== "localhost")
    return null;
  return host + normalizePath(url.pathname);
}

export function originHost(graph: Graph): string {
  const origin = graph.facts.find((fact) => fact.id === "origin" && !fact.deleted);
  if (!origin) return "";
  let url: URL;
  try {
    const raw = origin.description.trim();
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    return "";
  }
  return normalizeHost(url.hostname);
}

function factHost(graph: Graph, fact: Fact, fallback: string): string {
  if (fact.asset_id) {
    const asset = graph.assets.find((value) => value.id === fact.asset_id);
    if (asset) return normalizeHost(asset.hostname);
  }
  return fallback;
}

/** Every distinct host+path surface recorded by active, non-origin Facts. */
export function coverageSurfaces(graph: Graph): CoverageSurface[] {
  const fallback = originHost(graph);
  const bySurface = new Map<string, CoverageSurface>();
  const add = (raw: string, fact: Fact, host: string) => {
    const surface = normalizeSurface(raw, host || fallback);
    if (!surface) return;
    const current = bySurface.get(surface) ?? { surface, fact_ids: [], evidence_ids: [], parameters: [] };
    if (!current.fact_ids.includes(fact.id)) current.fact_ids.push(fact.id);
    for (const id of fact.evidence_ids) if (!current.evidence_ids.includes(id)) current.evidence_ids.push(id);
    for (const source of fact.parameter_sources ?? [])
      if (!current.parameters.includes(source.parameter)) current.parameters.push(source.parameter);
    bySurface.set(surface, current);
  };
  for (const fact of graph.facts) {
    if (fact.id === "origin" || fact.deleted) continue;
    const host = factHost(graph, fact, fallback);
    for (const object of fact.objects ?? []) add(String(object), fact, host);
    if (fact.request?.url) add(fact.request.url, fact, host);
  }
  return [...bySurface.values()].sort((a, b) => a.surface.localeCompare(b.surface));
}

/** Server-side completion gate. Unknown extra surfaces are allowed; omissions are not. */
export function validateCoverage(graph: Graph, entries: CoverageEntry[]): CoverageCheck {
  const surfaces = coverageSurfaces(graph);
  const fallback = originHost(graph);
  const knownEvidence = new Set(graph.evidence.map((e) => e.id));
  /** A surface may be reported once per parameter; a surface-only row covers it. */
  const provided = new Set<string>();
  const coveredSurfaces = new Set<string>();
  const invalid: string[] = [];
  for (const entry of entries) {
    const surface = normalizeSurface(entry.surface, fallback, true);
    if (!surface) {
      invalid.push(`无法解析 surface「${entry.surface}」；请写 host/path 或绝对 URL`);
      continue;
    }
    const parameter = entry.parameter?.trim() ?? "";
    const key = `${surface}\u0000${parameter}`;
    if (provided.has(key)) {
      invalid.push(`surface「${surface}」${parameter ? `的参数「${parameter}」` : ""}重复`);
      continue;
    }
    provided.add(key);
    coveredSurfaces.add(surface);
    const evidenceIds = entry.evidence_ids ?? [];
    if (entry.status === "tested" && !evidenceIds.length)
      invalid.push(`surface「${surface}」标为 tested，但没有 evidence_ids`);
    if (entry.status === "waived" && !entry.reason?.trim())
      invalid.push(`surface「${surface}」标为 waived，但没有 reason`);
    const unknown = evidenceIds.filter((id) => !knownEvidence.has(id));
    if (unknown.length) invalid.push(`surface「${surface}」引用了不存在的证据 ${unknown.join(", ")}`);
  }
  const missing = surfaces.map((item) => item.surface).filter((surface) => !coveredSurfaces.has(surface));
  return { surfaces, missing, invalid };
}
