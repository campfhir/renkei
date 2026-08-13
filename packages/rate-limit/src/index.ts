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

  /** Resolves once a token is available, having consumed it. FIFO under contention. */
  take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
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
