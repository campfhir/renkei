/**
 * Per-user request limiting.
 *
 * A fixed window counted in memory. Two limitations worth stating rather than
 * discovering:
 *
 *   - It is **per process**. Behind N replicas the effective limit is N times
 *     the configured one. That is acceptable for what this is actually for —
 *     stopping one runaway agent loop from hammering Jira and burning the
 *     tenant's shared rate budget — and inadequate as a defence against a
 *     determined attacker, who should be met at the ingress instead.
 *   - It counts *tool calls arriving here*, not requests reaching Jira. One
 *     MCP call can be several REST calls; Jira's own 429s are surfaced back to
 *     the caller unchanged.
 *
 * Keyed by Atlassian account ID rather than by session or IP, so opening more
 * sessions does not buy more budget.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets. Sent as Retry-After on a refusal. */
  retryAfterSeconds: number;
  remaining: number;
}

const WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#limit = perMinute;
    this.#now = now;
  }

  check(key: string): RateLimitDecision {
    const at = this.#now();
    const existing = this.#windows.get(key);

    if (!existing || existing.resetAt <= at) {
      this.#windows.set(key, { count: 1, resetAt: at + WINDOW_MS });
      this.#sweep(at);
      return { allowed: true, retryAfterSeconds: 0, remaining: this.#limit - 1 };
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - at) / 1000));

    if (existing.count >= this.#limit) {
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSeconds, remaining: this.#limit - existing.count };
  }

  /**
   * Drops windows that have already reset. Called on the miss path only, so
   * the cost is amortized and there is no timer keeping the process alive.
   */
  #sweep(at: number): void {
    if (this.#windows.size < 1000) {
      return;
    }
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= at) {
        this.#windows.delete(key);
      }
    }
  }
}
