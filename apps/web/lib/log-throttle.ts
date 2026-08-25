/**
 * "Say this at most once per key per window, and tell me how many I
 * swallowed."
 *
 * For conditions that are worth knowing about ONCE and worthless a thousand
 * times: a webhook provider delivering to a subscription we no longer
 * recognise will keep delivering until it expires, and a warning per
 * delivery does not make that more true — it just buries everything else in
 * the log, which is the opposite of what a warning is for.
 *
 * Deliberately not a rate LIMITER: nothing is refused or delayed. The work
 * proceeds either way; only the logging is rationed.
 */

interface Window {
  resetAt: number;
  /** Occurrences since the last emitted line, not counting that one. */
  suppressed: number;
}

const windows = new Map<string, Window>();

/** Bounded, so a flood of distinct keys cannot grow the map without limit. */
const MAX_KEYS = 5_000;

export interface ThrottleVerdict {
  /** Whether to emit a line at all. */
  log: boolean;
  /** How many were swallowed since the last emitted line — worth reporting. */
  suppressed: number;
}

export function throttleLog(
  key: string,
  windowMs: number,
  now: number = Date.now()
): ThrottleVerdict {
  const existing = windows.get(key);
  if (existing && existing.resetAt > now) {
    existing.suppressed += 1;
    return { log: false, suppressed: existing.suppressed };
  }
  if (windows.size >= MAX_KEYS) windows.clear();
  const suppressed = existing?.suppressed ?? 0;
  windows.set(key, { resetAt: now + windowMs, suppressed: 0 });
  // The first line of a new window reports what the previous one hid, so a
  // long-running flood shows its true volume rather than looking like a
  // handful of isolated events.
  return { log: true, suppressed };
}

/** Test seam. */
export function resetLogThrottle(): void {
  windows.clear();
}
