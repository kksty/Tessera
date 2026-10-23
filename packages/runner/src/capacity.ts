/** SDK projection samples, request accounting and historical peaks have distinct lifetimes. */
export class Capacity {
  generation = 0;
  current: number | null = null;
  peak: number | null = null;
  compacting = false;
  awaitingResponse = false;
  private probe = false;
  private addedMaterial = false;
  // Observe the effective SDK settings without adding application budget rules.
  constructor(readonly window: number, readonly reserve: number, readonly keepRecent: number) {}
  get threshold() { return this.window - this.reserve; }
  sample(tokens: number | null | undefined, response = false) {
    if (this.compacting || (this.awaitingResponse && !response)) return;
    if (response) this.awaitingResponse = false;
    this.current = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
    if (this.current !== null) this.peak = Math.max(this.peak ?? 0, this.current);
  }
  start() { this.compacting = true; this.current = null; this.probe = false; }
  end(success: boolean) {
    this.compacting = false;
    this.current = null;
    if (success) { this.generation++; this.awaitingResponse = true; this.probe = true; this.addedMaterial = false; }
    else { this.awaitingResponse = false; this.probe = false; }
  }
  materialAdded() { if (this.probe) this.addedMaterial = true; }
  /** Call once for the first main request, never for summary requests. */
  request() {
    const check = this.probe && !this.addedMaterial;
    this.probe = false;
    return { check, generation: this.generation };
  }
  snapshot() { return { generation: this.generation, current: this.current, known: this.current !== null,
    peak: this.peak, source: "pi_session_projection_estimate", window: this.window,
    reserve: this.reserve, threshold: this.threshold, keep_recent: this.keepRecent }; }
}
