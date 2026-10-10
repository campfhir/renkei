/**
 * Applying the org `logLevel` dial at runtime — the mechanism behind
 * "dynamically set log levels while running": every log-writing process
 * (the web app and each worker) polls the organization's setting and pushes
 * the result onto its own adapters, so a saved change takes effect on the
 * next poll instead of at the next deploy.
 */

import { getOrgSettings, type LogLevel } from './index';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * The level every log-writing process should apply right now, or null when
 * there is nothing to apply (the database is unreachable) — callers should
 * leave the adapter's current level alone rather than reset it to a guess.
 */
export async function getEffectiveLogLevel(): Promise<LogLevel | null> {
  const settings = await getOrgSettings();
  if (!settings.ok) return null;
  return settings.val.logLevel;
}

interface LevelHolder {
  level: string;
}

function hasLevel(value: unknown): value is LevelHolder {
  return (
    typeof value === 'object' &&
    value !== null &&
    'level' in value &&
    typeof value.level === 'string'
  );
}

/**
 * Apply the effective org log level to every adapter on `logger` now, then
 * again every `intervalMs`. Reads `logger.adapters` live on each tick
 * (never a snapshot), so an adapter registered after this call — the web
 * app's PostgresAdapter attaches later, from instrumentation.ts's async
 * `register()` hook — is picked up on the next pass regardless of call
 * order.
 *
 * Safe to call once per process and leave running for its lifetime: the
 * timer is unref'd so it never keeps the process alive on its own, and a
 * database hiccup just skips that tick rather than resetting the level —
 * `apply` never rejects, so a failure here (a misbehaving test double
 * included) can never surface as an unhandled rejection and take down the
 * process this poller exists to keep logging for.
 *
 * Returns a stop function (tests only; production processes never call it).
 */
export function watchLogLevel(
  logger: { adapters: readonly unknown[] },
  intervalMs = DEFAULT_POLL_INTERVAL_MS
): () => void {
  const apply = async () => {
    try {
      const level = await getEffectiveLogLevel();
      if (level === null) return;
      for (const adapter of logger.adapters) {
        if (hasLevel(adapter)) adapter.level = level;
      }
    } catch {
      // Best-effort sync; the next poll retries.
    }
  };

  void apply();
  const timer = setInterval(() => void apply(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
