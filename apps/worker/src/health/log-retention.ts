/**
 * Log retention: purge each tenant's own bored-logs rows past that
 * tenant's `logRetentionDays` dial.
 *
 * Previously this sweep purged nothing at all unless EVERY tenant had
 * opted into a finite retention, and even then only past the LONGEST
 * retention any tenant asked for — bored-logs' own `purge()` takes a bare
 * date cutoff with no tenant filter, and the `logs` table has no tenant
 * column, so a single global purge could not honor one tenant's dial
 * without also purging (or sparing) everyone else's rows in the same
 * range. Deleting straight through each row's `tenantId` attribute
 * instead makes retention genuinely organizational: one tenant's dial
 * governs only that tenant's rows, independent of what any other tenant
 * has chosen.
 *
 * Batched the same way bored-logs' own purge does: one short atomic
 * statement per batch. The `batch` CTE captures up to BATCH_SIZE matching
 * log ids once; the three DELETEs that follow all read that same captured
 * set (a WITH clause's siblings share one snapshot in Postgres), so every
 * delete targets exactly those rows and nothing can be half-deleted or
 * double-counted across the blob/attribute/log tables. Capped per tenant
 * per pass so one tenant's huge backlog cannot starve the others or hold
 * the sweep open indefinitely — the remainder is picked up on the next
 * pass, LOG_RETENTION_SWEEP_INTERVAL_MS later.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { logger } from '../logger';

const COMPONENT = 'logs/retention-sweep';

export const LOG_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** Rows deleted per atomic batch — the same order of magnitude as bored-logs' own purge batches. */
const BATCH_SIZE = 2_000;

/**
 * Cap per tenant per pass: at most this many batches, so one tenant with a
 * huge backlog cannot starve the others or hold the sweep open
 * indefinitely. The remainder waits for the next pass.
 */
const MAX_BATCHES_PER_TENANT = 50;

export async function sweepLogRetention(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  const db = dbResult.val;

  /**
   * Delete one batch of a tenant's log rows logged at or before `until`.
   * Returns the number of `logs` rows removed — fewer than BATCH_SIZE
   * means the tenant has nothing left to purge.
   */
  async function purgeTenantBatch(tenantId: string, until: Date): Promise<number> {
    const result = await sql<{ deleted: string }>`
      WITH batch AS (
        SELECT log_id FROM log_attr
        WHERE val_name = 'tenantId' AND val = ${tenantId} AND logged_timestamp <= ${until}
        LIMIT ${BATCH_SIZE}
      ),
      del_blob AS (
        DELETE FROM log_attr_blob WHERE log_id IN (SELECT log_id FROM batch)
      ),
      del_attr AS (
        DELETE FROM log_attr WHERE log_id IN (SELECT log_id FROM batch)
      ),
      del_logs AS (
        DELETE FROM logs WHERE log_id IN (SELECT log_id FROM batch)
      )
      SELECT count(*)::text AS deleted FROM batch
    `.execute(db);
    return Number(result.rows[0]?.deleted ?? 0);
  }

  /** Purge one tenant's rows past `until`, in batches, up to the per-pass cap. */
  async function purgeTenant(tenantId: string, until: Date): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TENANT; i++) {
      const deleted = await purgeTenantBatch(tenantId, until);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }

  let tenants: { id: string }[];
  try {
    tenants = await db.selectFrom('tenants').select('id').execute();
  } catch (error) {
    logger.error('could not list tenants: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const tenant of tenants) {
    const settings = await getOrgSettings(tenant.id);
    const days = settings.ok ? settings.val.logRetentionDays : 0;
    // 0 (or unreadable) = this tenant keeps its own logs forever.
    if (days <= 0) continue;

    const until = new Date(Date.now() - days * 24 * 60 * 60_000);
    try {
      const deleted = await purgeTenant(tenant.id, until);
      if (deleted > 0) {
        logger.info('purged {deleted} log row(s) for tenant {tenantId} older than {days} day(s)', {
          component: COMPONENT,
          tenantId: tenant.id,
          deleted,
          days,
        });
      }
    } catch (error) {
      logger.error('log purge failed for tenant {tenantId}: {error}', {
        component: COMPONENT,
        tenantId: tenant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
