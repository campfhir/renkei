/**
 * @renkei/rate-limit — a token-bucket limiter for outbound connector calls.
 *
 * The bucket fills to `capacity` (an allowed burst), drains one token per
 * `take()`, and refills continuously at `refillPerSecond`. A caller that
 * arrives when the bucket is empty queues (FIFO) and is flushed the moment
 * enough time has passed for another token to exist — not on a fixed tick.
 *
 * Built for the connector clients (webex, microsoft, zoom, atlassian): a
 * webhook flood or a sweep iterating many tenants can otherwise fire many
 * requests at a third-party API in one synchronous burst. A single bucket
 * per connector module — process-scoped, shared by every caller in that
 * process — spreads such a burst out over time instead of sending it all at
 * once, independent of how many separate callers show up at once.
 */

export interface RateLimiterOptions {
  /** Tokens the bucket can hold — the size of an allowed burst before throttling kicks in. */
  capacity: number;
  /** Tokens added back per second once the bucket is below capacity. */
  refillPerSecond: number;
}

/**
 * Thrown by `take()` when `timeoutMs` expires before a token freed up.
 * Distinguishable from every other failure a caller might see so a queue
 * that is merely slow (fix: raise capacity, or wait) is never confused
 * with one that is actually broken (fix: something else).
 */
export class RateLimitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`rate limit queue timed out after ${timeoutMs}ms`);
    this.name = 'RateLimitTimeoutError';
  }
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefillAt: number;
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.tokens = options.capacity;
    this.lastRefillAt = Date.now();
  }

  /**
   * Resolves once a token is available, having consumed it. FIFO under
   * contention. With `timeoutMs`, a caller stuck behind a deep queue is
   * dequeued and rejected with `RateLimitTimeoutError` instead of waiting
   * indefinitely — a queue with no ceiling turns "the bucket is undersized"
   * into "the request hangs for as long as the burst lasts", which for a
   * person or agent waiting on a live call is the same as it never
   * returning.
   */
  take(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const entry = (): void => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.queue.push(entry);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          // Not found means drain() already dequeued and resolved it in the
          // same tick the timer fired — a race decided in the caller's favor.
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(new RateLimitTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.drain();
    });
  }

  /** Tokens available right now (after refilling for elapsed time) — for tests/observability. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = now;
  }

  /**
   * Flush every queued waiter the current tokens allow, then arm a single
   * timer for the rest — guarded so concurrent take() calls in the same
   * burst never stack up redundant timers.
   */
  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length === 0 || this.timer) return;
    const msUntilNextToken = Math.max(1, (1 - this.tokens) / this.refillPerMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, msUntilNextToken);
  }
}

/**
 * Which kind of work a request belongs to.
 *
 * 'interactive' is on a person's critical path — an MCP tool call, or the ACL
 * verification behind a knowledge search. 'background' is everything the
 * system does to itself: webhook ingestion, delta sweeps, reconciliation.
 */
export type RequestLane = 'interactive' | 'background';

/**
 * Two buckets, one per lane, so background work cannot starve a waiting user.
 *
 * A single shared bucket per connector was the original design, and it had a
 * failure mode that read as something else entirely: a webhook flood would
 * drain the tokens, an interactive ACL check would queue behind it, and the
 * retrieval gate — which drops whatever is unverified when its budget expires
 * — would withhold results that the user was in fact allowed to see. The user
 * saw fewer results, indistinguishable from "you do not have access".
 *
 * Separating the lanes fixes the direction that matters. The lanes do not
 * share tokens: an idle interactive lane lends nothing to a busy background
 * one, which is the point — the reserve has to be there at the moment the
 * user arrives, not on average.
 *
 * Rate limits at the provider are per-app, so the two lanes together are what
 * the third party sees; size them as a pair, not independently.
 */
export class LaneLimiter {
  private readonly interactive: TokenBucket;
  private readonly background: TokenBucket;

  constructor(config: Record<RequestLane, RateLimiterOptions>) {
    this.interactive = new TokenBucket(config.interactive);
    this.background = new TokenBucket(config.background);
  }

  /**
   * Defaults to 'background': a caller that has not thought about which lane
   * it is in is, by definition, not the one holding a person up, and the
   * conservative lane is the safe place to be wrong.
   */
  take(lane: RequestLane = 'background', timeoutMs?: number): Promise<void> {
    return lane === 'interactive'
      ? this.interactive.take(timeoutMs)
      : this.background.take(timeoutMs);
  }
}
