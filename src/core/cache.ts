/**
 * Minimal in-process TTL cache.
 *
 * Phase 1 runs single-process, so this is deliberately small rather than a
 * Redis dependency. The interface is the one a Redis-backed cache would
 * expose, so Phase 2 can swap the implementation without touching callers.
 *
 * It matters for more than speed: several upstream sources cap how often we
 * may poll them (Remotive asks for at most ~4 requests/day), so connector
 * results are served from here between refreshes.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.defaultTtlMs): void {
    // Cheap bound: drop the oldest insertion when full. Map preserves order.
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Age of a live entry in ms, or null when absent/expired. */
  ageMs(key: string): number | null {
    const hit = this.store.get(key);
    if (!hit || hit.expiresAt <= Date.now()) return null;
    return this.defaultTtlMs - (hit.expiresAt - Date.now());
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
