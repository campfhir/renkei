/**
 * The two housekeeping sweeps: retention (delete run history past each
 * org's window) and the stuck-run janitor (close runs whose queue job is
 * gone). Both are idempotent and re-runnable, so N replicas sweeping at
 * once cost duplicate reads, never wrong writes.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { logger } from './logger';

const RETENTION_BATCH = 500;

/**
 * Delete runs older than each tenant's agentRunRetentionDays. Batched so a
 * neglected table never produces one giant delete; steps go via cascade.
 * One batch per tenant per pass — the hourly cadence catches up quickly
 * and a pass stays cheap.
 */
export function createRetentionSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const tenants = await db.selectFrom('agent_runs').select('tenant_id').distinct().execute();

    for (const { tenant_id: tenantId } of tenants) {
      const settingsResult = await getOrgSettings(tenantId);
      if (!settingsResult.ok) continue;
      const days = settingsResult.val.agentRunRetentionDays;

      const deleted = await sql<{ id: string }>`
        DELETE FROM agent_runs WHERE id IN (
          SELECT id FROM agent_runs
          WHERE tenant_id = ${tenantId}
            AND status IN ('succeeded', 'failed', 'canceled')
            AND created_at < NOW() - make_interval(days => ${days})
          ORDER BY created_at
          LIMIT ${RETENTION_BATCH}
        ) RETURNING id
      `.execute(db);
      if (deleted.rows.length > 0) {
        logger.info('retention pruned {count} runs for tenant {tenantId}', {
          component: 'worker-agents/retention',
          tenantId,
          count: deleted.rows.length,
        });
      }
    }
  };
}

/**
 * Close runs the queue has forgotten. A 'running' run whose wall clock is
 * spent AND whose agent_jobs row no longer exists (completed, dead-lettered
 * with a stale payload, or manually purged) will never be claimed again —
 * without this it would sit as 'running' forever, holding its agent's
 * ordering key hostage in every human's mental model if not the queue's.
 *
 * The live-job check is what keeps the janitor from racing a real worker:
 * a slow-but-alive run still has its processing row, and is left alone.
 */
export function createStuckRunJanitor(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const stuck = await db
      .selectFrom('agent_runs')
      .select(['id', 'tenant_id', 'started_at'])
      .where('status', 'in', ['queued', 'running'])
      .where('created_at', '<', sql<Date>`NOW() - INTERVAL '2 hours'`)
      .limit(50)
      .execute();

    for (const run of stuck) {
      const liveJob = await db
        .selectFrom('agent_jobs')
        .select('id')
        .where('status', 'in', ['pending', 'processing'])
        .where(sql<string>`payload->>'runId'`, '=', run.id)
        .executeTakeFirst();
      if (liveJob) continue;

      await db
        .updateTable('agent_runs')
        .set({
          status: 'failed',
          error_kind: 'timeout',
          error: 'The run was abandoned — its job left the queue without finishing.',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', run.id)
        .where('status', 'in', ['queued', 'running'])
        .execute();
      logger.warn('janitor closed abandoned run {runId}', {
        component: 'worker-agents/janitor',
        runId: run.id,
        tenantId: run.tenant_id,
      });
    }
  };
}
