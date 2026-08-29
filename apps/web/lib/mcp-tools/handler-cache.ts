/**
 * A bounded, expiring cache of built MCP handlers.
 *
 * The previous one was a bare `Map` with no eviction and no TTL. Every
 * distinct combination of scopes, settings and email minted an entry that
 * was never freed, so the map grew for the life of the process and a
 * handler built from a key that had drifted out of date was served
 * indefinitely. Both properties are addressed here rather than in the route,
 * because "how long may a handler live" is a decision about this cache, not
 * about MCP.
 *
 * The TTL is a backstop, not the mechanism: correctness comes from the key
 * (see surface-version.ts), and the TTL only bounds how long a handler can
 * outlive a change the version somehow missed. That is why it is generous —
 * rebuilding registers ~270 tools, and doing that on a timer rather than on
 * a real change would be pure waste.
 *
 * Eviction is insertion-ordered rather than true LRU. JavaScript `Map`
 * iterates in insertion order, so the oldest entry is `keys().next()`, and
 * refreshing an entry on read (delete + set) is what turns that into LRU.
 * Handlers are interchangeable and cheap to rebuild, so the distinction
 * costs little either way.
 */

export type CachedHandler = (request: Request) => Promise<Response>;

/** Long enough that a rebuild is rare; short enough to bound a missed change. */
const TTL_MS = 30 * 60_000;

/**
 * Enough for a busy tenant's active clients, small enough that a leak is a
 * bounded one. Each entry holds ~270 registered tools and their closures.
 */
const MAX_ENTRIES = 500;

interface Entry {
  handler: CachedHandler;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

/**
 * The handler for `key`, or undefined when absent or expired.
 *
 * A hit is re-inserted so it becomes the newest entry — that is what makes
 * eviction least-recently-USED rather than least-recently-created, and it
 * matters because a handler in constant use should not be evicted ahead of
 * one built minutes ago and never touched again.
 */
export function getHandler(key: string): CachedHandler | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry.handler;
}

/** Store `handler`, evicting the oldest entries if the cache is full. */
export function setHandler(key: string, handler: CachedHandler): void {
  entries.delete(key);
  entries.set(key, { handler, expiresAt: Date.now() + TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Test seam: the current entry count. */
export function handlerCacheSize(): number {
  return entries.size;
}

/** Test seam: drop everything. */
export function clearHandlerCache(): void {
  entries.clear();
}
