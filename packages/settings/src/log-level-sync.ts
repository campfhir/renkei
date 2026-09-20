/**
 * Applying the org `logLevel` dial at runtime — the mechanism behind
 * "dynamically set log levels while running": every log-writing process
 * (the web app and each worker) polls the tenants it serves and pushes the
 * result onto its own adapters, so a saved change takes effect on the next
 * poll instead of at the next deploy.
 *
 * A level can't be sliced per tenant the way retention can: the adapters
 * are per-process, shared by every tenant that process happens to serve,
 * so there is one write-time level in effect at a time. The safe failure
 * mode is showing more than a stricter tenant asked for, not silently
 * dropping what a verbose tenant is actively trying to see — the same
 * choice `logRetentionDays` makes when tenants disagree (see
 * apps/worker/src/health/log-retention.ts), applied here to verbosity
 * instead of deletion: the effective level is the MOST VERBOSE level any
 * tenant has configured.
 */

import { getDatabase } from '@renkei/db';
import { getOrgSettings, LOG_LEVEL_RANK, DEFAULT_ORG_SETTINGS, type LogLevel } from './index';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * The level every log-writing process should apply right now, or null when
 * there is nothing to apply (no tenants yet, or the database is
 * unreachable) — callers should leave the adapter's current level alone
 * rather than reset it to a guess.
 */
export async function getEffectiveLogLevel(): Promise<LogLevel | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  let tenants: { id: string }[];
  try {
    tenants = await dbResult.val.selectFrom('tenants').select('id').execute();
  } catch {
    return null;
  }
  if (tenants.length === 0) return null;

  let effective: LogLevel = 'critical';
  for (const tenant of tenants) {
    const settings = await getOrgSettings(tenant.id);
    const level = settings.ok ? settings.val.logLevel : DEFAULT_ORG_SETTINGS.logLevel;
    if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[effective]) effective = level;
  }
  return effective;
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
 * database hiccup just skips that tick rather than resetting the level.
 *
 * Returns a stop function (tests only; production processes never call it).
 */
export function watchLogLevel(
  logger: { adapters: readonly unknown[] },
  intervalMs = DEFAULT_POLL_INTERVAL_MS
): () => void {
  const apply = async () => {
    const level = await getEffectiveLogLevel();
    if (level === null) return;
    for (const adapter of logger.adapters) {
      if (hasLevel(adapter)) adapter.level = level;
    }
  };

  void apply();
  const timer = setInterval(() => void apply(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
