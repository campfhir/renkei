/**
 * A REJECTING fixed-window limiter for unauthenticated inbound endpoints.
 *
 * Deliberately not @renkei/rate-limit: that one is a token bucket for
 * OUTBOUND connector calls, and a caller who finds it empty *queues* until a
 * token exists. Queueing is right when you are being polite to someone
 * else's API and wrong when you are being abused — a loop would simply wait
 * its turn, hold a request open, and still succeed every time. Here the
 * answer to "too many" is 429, immediately.
 *
 * TWO LIMITS ON PURPOSE. The per-client limit is keyed on a forwarded IP
 * header, which the proxy's own comment is careful to call observability
 * rather than a trust decision — anyone can put whatever they like in
 * X-Forwarded-For. So it is backed by a GLOBAL limit for the same endpoint,
 * which no amount of header spoofing can widen. The per-client one keeps one
 * noisy client from consuming the global budget; the global one is the
 * actual ceiling.
 *
 * Process-scoped, in memory. With N replicas the effective ceiling is N×,
 * and a restart forgives everything — fine for slowing abuse of a low-volume
 * endpoint, not a substitute for a real quota. Anything needing exactness
 * across replicas belongs in the database.
 */

interface Window {
  count: number;
  /** Epoch ms when this window expires and the count resets. */
  resetAt: number;
}

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the caller may retry — for the Retry-After header. */
  retryAfterSeconds: number;
}

const windows = new Map<string, Window>();

/**
 * Bounded so a spoofed-header flood cannot grow the map without limit: past
 * this many live keys, the whole table is dropped rather than tracked. That
 * forgives everyone briefly — the global limit is what still holds, which is
 * exactly why it exists.
 */
const MAX_TRACKED_KEYS = 10_000;

function hit(key: string, rule: RateLimitRule, now: number): RateLimitVerdict {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  if (existing.count > rule.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Drop expired windows; if the table is still oversized, clear it. */
function prune(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
}

/** The forwarded client address, or a constant when nothing is forwarded. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  // The left-most entry is the original client as claimed by the chain.
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Charge one request against the endpoint's global budget AND the caller's
 * own. Denied when either is exhausted; the caller is told which by nothing
 * at all, on purpose.
 */
export function checkInboundLimit(
  endpoint: string,
  request: Request,
  rules: { perClient: RateLimitRule; global: RateLimitRule },
  now: number = Date.now()
): RateLimitVerdict {
  prune(now);
  const globalVerdict = hit(`${endpoint}:global`, rules.global, now);
  const clientVerdict = hit(`${endpoint}:client:${clientKey(request)}`, rules.perClient, now);
  if (globalVerdict.allowed && clientVerdict.allowed) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(globalVerdict.retryAfterSeconds, clientVerdict.retryAfterSeconds),
  };
}

/** Test seam: forget every window. */
export function resetInboundLimits(): void {
  windows.clear();
}
