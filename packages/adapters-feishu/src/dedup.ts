/**
 * Bounded LRU-ish dedup set for event_ids. Feishu delivers at-least-once.
 */
export class EventDedup {
  private seen = new Map<string, number>();
  constructor(
    private readonly maxSize = 1000,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  has(id: string): boolean {
    const t = this.seen.get(id);
    if (t === undefined) return false;
    if (Date.now() - t > this.ttlMs) {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  add(id: string): void {
    if (this.seen.size >= this.maxSize) {
      // drop oldest
      const firstKey = this.seen.keys().next().value;
      if (firstKey) this.seen.delete(firstKey);
    }
    this.seen.set(id, Date.now());
  }
}
