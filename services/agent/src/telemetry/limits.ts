/** Per-key rate rules for what the agent sends. Keys come from closed sets, so both maps stay small. */
export class Limits {
  private counts = new Map<string, number>();
  private last = new Map<string, number>();

  /** True for the first `max` calls with this key. */
  cap(key: string, max: number): boolean {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= max;
  }

  /** True unless this key already passed within the last `ms`. */
  window(key: string, ms: number, now = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < ms) return false;
    this.last.set(key, now);
    return true;
  }

  clear(): void {
    this.counts.clear();
    this.last.clear();
  }
}

export const limits = new Limits();
