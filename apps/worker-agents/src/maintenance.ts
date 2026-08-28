/**
 * The two housekeeping sweeps: retention (delete run history past each
 * org's window) and the stuck-run janitor (close runs whose queue job is
 * gone). Both are idempotent and re-runnable, so N replicas sweeping at
 * once cost duplicate reads, never wrong writes.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { CURRENT_STEPS_VERSION } from '@renkei/agents';
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
            AND status IN ('succeeded', 'failed', 'canceled', 'stopped')
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
 * Delete notifications older than each tenant's
 * agentNotificationRetentionDays — the same shape as the run sweep above,
 * and unwrapped by `withSweepLock` for the same reason: a bounded DELETE is
 * idempotent, so two replicas running it cost a duplicate read and never a
 * wrong write.
 *
 * A notification is deleted whether or not it was ever read. Retention is
 * about how long the record of an act lives, not about whether somebody got
 * round to looking — and an unread notification from three weeks ago is not
 * going to be read now.
 */
export function createNotificationRetentionSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const tenants = await db
      .selectFrom('agent_notifications')
      .select('tenant_id')
      .distinct()
      .execute();

    for (const { tenant_id: tenantId } of tenants) {
      const settingsResult = await getOrgSettings(tenantId);
      if (!settingsResult.ok) continue;
      const days = settingsResult.val.agentNotificationRetentionDays;

      const deleted = await sql<{ id: string }>`
        DELETE FROM agent_notifications WHERE id IN (
          SELECT id FROM agent_notifications
          WHERE tenant_id = ${tenantId}
            AND created_at < NOW() - make_interval(days => ${days})
          ORDER BY created_at
          LIMIT ${RETENTION_BATCH}
        ) RETURNING id
      `.execute(db);
      if (deleted.rows.length > 0) {
        logger.info('retention pruned {count} notifications for tenant {tenantId}', {
          component: 'worker-agents/notification-retention',
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

/**
 * Disable agents saved in an older steps format, and tell their owners.
 *
 * There is no per-version maintenance any more: run creation demands the
 * current version (isCurrentStepsDoc), so an agent left on an older number
 * would just silently never fire. This sweep turns that silence into the
 * two things the owner needs — the agent visibly OFF, and a notification
 * saying exactly what to do (open it in the builder and save, which
 * re-stamps it with the current version). Idempotent: a disabled agent no
 * longer matches the WHERE, so each stale agent is handled exactly once,
 * however many replicas sweep.
 */
export function createStaleVersionSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const stale = await sql<{
      id: string;
      tenant_id: string;
      owner_subject: string;
      name: string;
    }>`
      UPDATE agents
         SET enabled = false, updated_at = NOW()
       WHERE enabled = true
         AND (steps->>'version')::int < ${CURRENT_STEPS_VERSION}
      RETURNING id, tenant_id, owner_subject, name
    `.execute(db);

    for (const agent of stale.rows) {
      try {
        await db
          .insertInto('agent_notifications')
          .values({
            id: randomUUID(),
            tenant_id: agent.tenant_id,
            subject: agent.owner_subject,
            kind: 'agent_disabled',
            headline:
              `“${agent.name}” was turned off — it is saved in an older format. ` +
              `Open it in the builder and save to update it, then turn it back on.`,
            agent_id: agent.id,
            agent_name: agent.name,
          })
          .execute();
      } catch (error) {
        // The disable already happened and is the part that matters; a
        // missed notification costs reach, not correctness.
        logger.warn('could not notify owner of stale-version agent {agentId}', {
          component: 'worker-agents/stale-version',
          tenantId: agent.tenant_id,
          agentId: agent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      logger.warn('disabled stale-version agent {agentId} ({name})', {
        component: 'worker-agents/stale-version',
        tenantId: agent.tenant_id,
        agentId: agent.id,
        name: agent.name,
      });
    }
  };
}
