/**
 * Log retention: purge bored-logs rows older than the org dial
 * (`logRetentionDays`) allows.
 *
 * The logs table is deployment-wide — rows from every tenant interleave and
 * the adapter's purge cannot slice by tenant — so the sweep applies the most
 * conservative reading of the per-org dials: it purges only when EVERY
 * tenant has opted into a finite retention (>0 days), and then only past the
 * LONGEST retention any tenant asked for. One tenant keeping the default
 * (0 = forever) keeps everything, which is the safe failure mode for
 * observability data.
 *
 * The purge itself is bored-logs' own job machinery: purge() plans and
 * batch-deletes in the background on this adapter's timers, resumable across
 * restarts via the adapter's own job sweep. The confirmation threshold is
 * lifted — retention is a standing policy, not an interactive deletion, and
 * a sweep cannot click a confirm button.
 */

import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { requireLogCipher } from '../log-encryption';
import { logger } from '../logger';

const COMPONENT = 'logs/retention-sweep';

export const LOG_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Purge-only adapter, created once and kept for the process lifetime: its
 * background timers are what drain (and resume) purge jobs. Deliberately
 * NEVER attached to the logger — this process may be in HTTP-ship mode
 * where the web app is the single log writer, and attaching would fork the
 * write path.
 */
let purgeAdapter: PostgresAdapter | null = null;

function getPurgeAdapter(): PostgresAdapter | null {
  if (purgeAdapter) return purgeAdapter;
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  try {
    const cipher = requireLogCipher();
    purgeAdapter = new PostgresAdapter({
      db: dbResult.val,
      // Nothing is ever logged through this adapter; the level is moot.
      level: 'error',
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
    });
  } catch (error) {
    // HTTP-ship deployments may run the worker without the log encryption
    // key. Retention then needs the key added — say so instead of dying.
    logger.warn('log retention needs LOG_ENCRYPTION_KEY on this worker: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return purgeAdapter;
}

export async function sweepLogRetention(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;

  let tenants: { id: string }[];
  try {
    tenants = await dbResult.val.selectFrom('tenants').select('id').execute();
  } catch (error) {
    logger.error('could not list tenants: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (tenants.length === 0) return;

  let maxDays = 0;
  for (const tenant of tenants) {
    const settings = await getOrgSettings(tenant.id);
    const days = settings.ok ? settings.val.logRetentionDays : 0;
    // 0 (or unreadable) = keep forever; one such tenant vetoes the purge.
    if (days <= 0) return;
    maxDays = Math.max(maxDays, days);
  }

  const adapter = getPurgeAdapter();
  if (!adapter) return;

  const until = new Date(Date.now() - maxDays * 24 * 60 * 60_000);
  const result = await adapter.purge(until, {
    confirmationThreshold: Number.MAX_SAFE_INTEGER,
  });
  if (!result.ok) {
    logger.error('log purge failed: {error}', {
      component: COMPONENT,
      error: result.err.message,
    });
    return;
  }
  if (result.val.logCount > 0) {
    logger.info('purging {logCount} log row(s) older than {days} day(s)', {
      component: COMPONENT,
      logCount: result.val.logCount,
      days: maxDays,
    });
  }
}
