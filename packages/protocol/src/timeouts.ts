/**
 * One budget for every client that talks to the control plane.
 *
 * The rule that keeps a Run alive is: lease > worst-case heartbeat > server
 * p99.9. Every value here is derived from that rule, not chosen per call site,
 * so a slow claim can never outlive the lease it is waiting on and a single
 * slow write can never turn into a false "task failure".
 */
export interface TimeoutBudget {
  /** Server-side lease for Decide/Execute/Review. A dead Worker is reclaimed after this. */
  lease_seconds: number;
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  /** Consecutive failed heartbeats before the Run is abandoned. */
  heartbeat_max_failures: number;
  /** claim/release: longer than the server's slow tail, shorter than the lease. */
  claim_ms: number;
  /** Fire-and-forget cancel of a claim the client gave up on. */
  cancel_ms: number;
  /** Release after a finished job; not worth blocking the scheduler slot. */
  release_ms: number;
  commit_ms: number;
  commit_attempts: number;
  usage_ms: number;
  diagnostics_ms: number;
  model_ms: number;
}

export const TIMEOUT_DEFAULTS: Readonly<TimeoutBudget> = Object.freeze({
  lease_seconds: 180,
  heartbeat_interval_ms: 15_000,
  heartbeat_timeout_ms: 45_000,
  heartbeat_max_failures: 3,
  claim_ms: 90_000,
  cancel_ms: 5_000,
  release_ms: 30_000,
  commit_ms: 30_000,
  commit_attempts: 3,
  usage_ms: 30_000,
  diagnostics_ms: 15_000,
  model_ms: 600_000,
});

/** Deployment overrides. Only values an operator may legitimately tune are exposed. */
export function timeoutsFromEnv(environment: NodeJS.ProcessEnv = process.env): TimeoutBudget {
  const numeric = (name: string, fallback: number) => {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid numeric environment variable: ${name}`);
    return value;
  };
  return {
    ...TIMEOUT_DEFAULTS,
    lease_seconds: numeric("TESSERA_LEASE_SECONDS", TIMEOUT_DEFAULTS.lease_seconds),
    heartbeat_interval_ms: numeric("TESSERA_HEARTBEAT_MS", TIMEOUT_DEFAULTS.heartbeat_interval_ms),
    heartbeat_timeout_ms: numeric("TESSERA_HEARTBEAT_TIMEOUT_MS", TIMEOUT_DEFAULTS.heartbeat_timeout_ms),
    commit_ms: numeric("TESSERA_COMMIT_TIMEOUT_MS", TIMEOUT_DEFAULTS.commit_ms),
    usage_ms: numeric("TESSERA_USAGE_TIMEOUT_MS", TIMEOUT_DEFAULTS.usage_ms),
    diagnostics_ms: numeric("TESSERA_DIAGNOSTICS_TIMEOUT_MS", TIMEOUT_DEFAULTS.diagnostics_ms),
    model_ms: numeric("TESSERA_MODEL_TIMEOUT_MS", TIMEOUT_DEFAULTS.model_ms),
  };
}

export function resolveTimeouts(overrides: Partial<TimeoutBudget> = {}): TimeoutBudget {
  return { ...timeoutsFromEnv(), ...overrides };
}
