import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Control-plane observation. The question this answers is not "was the model
 * slow" but "how much of a request's wall time was queueing, handler work and
 * SQLite write, and was the event loop blocked while it happened". Nothing here
 * gates behaviour: recording a sample can never fail a Run.
 */
type Stats = { count: number; total_ms: number; max_ms: number; samples: number[] };

const MAX_SAMPLES = 512;
const MAX_ROUTES = 200;
const SLOW_MS = 500;
const MAX_SLOW = 40;
const OTHER = "(other)";

const round = (value: number) => Math.round(value * 10) / 10;

function percentile(samples: number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]);
}

function empty(): Stats {
  return { count: 0, total_ms: 0, max_ms: 0, samples: [] };
}

export class ControlPlaneMetrics {
  readonly started_at = new Date().toISOString();
  private routes = new Map<string, Stats>();
  private transactions: Stats = empty();
  private slow: { at: string; method: string; route: string; ms: number; status: number }[] = [];
  private loop = { window_ms: 0, mean_ms: 0, p99_ms: 0, max_ms: 0, min_ms: 0, samples: 0 };
  private loopTimer?: ReturnType<typeof monitorEventLoopDelay>;

  recordRequest(route: string, method: string, ms: number, status: number) {
    const key = `${method} ${route || "/"}`;
    const bucket = this.routes.get(key) ?? (this.routes.size < MAX_ROUTES ? this.routes.set(key, empty()).get(key)! : this.routes.get(OTHER) ?? this.routes.set(OTHER, empty()).get(OTHER)!);
    bucket.count++;
    bucket.total_ms += ms;
    bucket.max_ms = Math.max(bucket.max_ms, ms);
    if (bucket.samples.length < MAX_SAMPLES) bucket.samples.push(ms);
    if (ms >= SLOW_MS) {
      this.slow.push({ at: new Date().toISOString(), method, route, ms: round(ms), status });
      if (this.slow.length > MAX_SLOW) this.slow.splice(0, this.slow.length - MAX_SLOW);
    }
  }

  recordTransaction(ms: number) {
    this.transactions.count++;
    this.transactions.total_ms += ms;
    this.transactions.max_ms = Math.max(this.transactions.max_ms, ms);
    if (this.transactions.samples.length < MAX_SAMPLES) this.transactions.samples.push(ms);
  }

  /** Start collection once per process; tests call this explicitly. */
  startEventLoopDelay(resolution = 20, windowMs = 5000) {
    if (this.loopTimer) return;
    const histogram = monitorEventLoopDelay({ resolution });
    histogram.enable();
    this.loopTimer = histogram;
    const timer = setInterval(() => {
      // min_ms is the platform floor: Windows timer granularity makes an idle
      // loop read 15-35ms, so a delay is only meaningful relative to that floor.
      this.loop = { window_ms: windowMs, mean_ms: round(histogram.mean / 1e6), p99_ms: round(histogram.percentile(99) / 1e6),
        max_ms: round(histogram.max / 1e6), min_ms: round(histogram.min / 1e6), samples: histogram.count };
      histogram.reset();
    }, windowMs);
    timer.unref();
  }

  stopEventLoopDelay() {
    this.loopTimer?.disable();
    this.loopTimer = undefined;
  }

  snapshot() {
    const requests = [...this.routes.entries()].map(([key, s]) => ({
      method: key.slice(0, key.indexOf(" ")), route: key.slice(key.indexOf(" ") + 1),
      count: s.count, mean_ms: round(s.total_ms / s.count),
      p50_ms: percentile(s.samples, 0.5), p99_ms: percentile(s.samples, 0.99), max_ms: round(s.max_ms),
    })).sort((a, b) => b.p99_ms - a.p99_ms || b.max_ms - a.max_ms).slice(0, 20);
    return {
      started_at: this.started_at, sampled_at: new Date().toISOString(),
      event_loop: this.loop,
      transactions: { count: this.transactions.count, mean_ms: round(this.transactions.total_ms / Math.max(1, this.transactions.count)),
        p50_ms: percentile(this.transactions.samples, 0.5), p99_ms: percentile(this.transactions.samples, 0.99),
        max_ms: round(this.transactions.max_ms) },
      requests, slow: this.slow.slice(-MAX_SLOW),
      note: "Server-side wall time per route (receive to response). A blocked event loop and a long transaction both appear here; client-side elapsed_ms lives on the submission/tool_end events.",
    };
  }
}

export const controlPlane = new ControlPlaneMetrics();
