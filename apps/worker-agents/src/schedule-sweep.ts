/**
 * Firing schedule triggers — the content_watches pattern with a stricter
 * fairness problem: N replicas of this process all sweep, and a trigger
 * must fire ONCE.
 *
 * The answer is advance-then-fire under an optimistic lock: the UPDATE
 * moves next_run_at forward only where it still equals the value this
 * sweep observed, so exactly one replica wins each due row and only the
 * winner creates the run. A lost race is silence, not an error.
 *
 * The next occurrence is computed from NOW (not from the missed slot), so
 * a worker down over a weekend fires a daily schedule once on Monday, not
 * three times.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { computeNextRun, isAgentStepsDoc, isRecurrence } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import { logger } from './logger';

const MAX_PER_PASS = 25;

export function createScheduleSweep(db: Kysely<DB>, producer: QueueProducer) {
  return async function sweep(): Promise<void> {
    const due = await db
      .selectFrom('agent_triggers as t')
      .innerJoin('agents as a', 'a.id', 't.agent_id')
      .select([
        't.id as trigger_id',
        't.tenant_id',
        't.agent_id',
        't.config',
        't.next_run_at',
        'a.owner_subject',
        'a.steps',
        'a.llm_model_id',
      ])
      .where('t.kind', '=', 'schedule')
      .where('t.enabled', '=', true)
      .where('a.enabled', '=', true)
      .where('t.next_run_at', 'is not', null)
      .where('t.next_run_at', '<=', sql<Date>`NOW()`)
      .orderBy('t.next_run_at')
      .limit(MAX_PER_PASS)
      .execute();

    for (const row of due) {
      const config: { recurrence?: unknown; timezone?: unknown } =
        typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
          ? row.config
          : {};
      if (!isRecurrence(config.recurrence) || typeof config.timezone !== 'string') {
        await db
          .updateTable('agent_triggers')
          .set({
            enabled: false,
            last_error: 'The schedule is malformed and was turned off.',
            updated_at: sql`NOW()`,
          })
          .where('id', '=', row.trigger_id)
          .execute();
        continue;
      }

      const observed = row.next_run_at;
      if (!observed) continue;
      const scheduledFor = observed.toISOString();
      const next = computeNextRun(config.recurrence, config.timezone, new Date());

      // The optimistic lock: one replica advances the row, the rest lose.
      const advanced = await db
        .updateTable('agent_triggers')
        .set({ next_run_at: next, last_fired_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', row.trigger_id)
        .where('next_run_at', '=', observed)
        .executeTakeFirst();
      if (Number(advanced.numUpdatedRows ?? 0) === 0) continue;

      if (!isAgentStepsDoc(row.steps)) {
        await recordTriggerError(db, row.trigger_id, 'The saved steps could not be read.');
        continue;
      }

      const result = await createAgentRun(db, producer, {
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        ownerSubject: row.owner_subject,
        steps: row.steps,
        llmModelId: row.llm_model_id,
        triggerId: row.trigger_id,
        triggerKind: 'schedule',
        // Just time/date, per spec: a schedule carries no other context.
        initialState: { scheduledFor, timezone: config.timezone },
      });
      if (!result.ok) {
        await recordTriggerError(
          db,
          row.trigger_id,
          result.err.message ?? `The run could not be started (${result.err.type}).`
        );
        continue;
      }
      await db
        .updateTable('agent_triggers')
        .set({ last_error: null, updated_at: sql`NOW()` })
        .where('id', '=', row.trigger_id)
        .execute();
      logger.debug('schedule fired: agent {agentId} run {runId}', {
        component: 'worker-agents/schedule',
        agentId: row.agent_id,
        runId: result.val.runId,
        tenantId: row.tenant_id,
      });
    }
  };
}

async function recordTriggerError(
  db: Kysely<DB>,
  triggerId: string,
  message: string
): Promise<void> {
  await db
    .updateTable('agent_triggers')
    .set({ last_error: message, updated_at: sql`NOW()` })
    .where('id', '=', triggerId)
    .execute();
}
