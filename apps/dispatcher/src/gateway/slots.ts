/**
 * Hands each concurrent Run of a project its own slice of that project's published
 * callback block. State is per-dispatcher and intentionally tiny: a set of taken slot
 * indices per project, released when the Run finishes.
 */
export class CallbackSlotRegistry {
  private readonly used = new Map<string, Set<number>>();

  /** Reserve the lowest free slot in [0, count); null when every slot is taken. */
  acquire(project: string, count: number): number | null {
    if (count < 1) return null;
    let taken = this.used.get(project);
    if (!taken) {
      taken = new Set();
      this.used.set(project, taken);
    }
    for (let slot = 0; slot < count; slot++)
      if (!taken.has(slot)) {
        taken.add(slot);
        return slot;
      }
    return null;
  }

  release(project: string, slot: number): void {
    const taken = this.used.get(project);
    if (!taken) return;
    taken.delete(slot);
    if (!taken.size) this.used.delete(project);
  }
}
