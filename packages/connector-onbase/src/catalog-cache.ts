/**
 * A small TTL cache for per-tenant OnBase vocabulary (keyword types,
 * document types). Name→id resolution needs the whole catalog, and
 * refetching it on every tool call would double the latency of every
 * search; five minutes of staleness on admin-curated vocabulary is a fine
 * trade. Only successes are cached — an error remembered as a catalog
 * would not heal on its own.
 */

export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CatalogCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number = CATALOG_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
