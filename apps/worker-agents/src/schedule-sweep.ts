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

import { agentAttrs, getDataStore, type AgentFields } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  agentDefinitionOf,
  isBlackoutEntry,
  parseScheduleConfig,
  type BlackoutEntry,
} from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import { logger } from './logger';

const MAX_PER_PASS = 25;

/**
 * The org calendar a schedule opted into, as a blackout predicate. A
 * calendar that no longer exists resolves to "no blackouts" (with a warn)
 * rather than disabling the trigger: the schedule itself is intact, only
 * its holiday overlay is gone.
 */
async function calendarDatesOf(calendarId: string, agent: AgentFields): Promise<BlackoutEntry[]> {
  const row = await getDataStore().scheduleCalendars.find(calendarId);
  if (!row) {
    logger.warn(
      'the calendar a schedule of agent "{agent}" of {owner} opted into no longer exists; the schedule fires without its blackout dates',
      {
        component: 'worker-agents/schedule',
        ...agent,
        calendarId,
      }
    );
    return [];
  }
  return Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [];
}

export function createScheduleSweep(producer: QueueProducer) {
  return async function sweep(): Promise<void> {
    const agents = getDataStore().agents;
    const due = await agents.listDueScheduleTriggers(new Date(), MAX_PER_PASS);

    for (const row of due) {
      // parseScheduleConfig also reads the pre-042 single-recurrence shape,
      // so a not-yet-migrated row still fires during a rolling deploy.
      const config = parseScheduleConfig(row.config);
      const agent = await agentAttrs(row.agentId);
      if (!config) {
        await agents.disableTrigger(row.triggerId, 'The schedule is malformed and was turned off.');
        logger.warn(
          'a schedule of agent "{agent}" of {owner} is malformed; it was turned off and the reason left on the trigger',
          {
            component: 'worker-agents/schedule',
            ...agent,
            triggerId: row.triggerId,
          }
        );
        continue;
      }

      const observed = row.nextRunAt;
      const scheduledFor = observed.toISOString();
      const calendarDates = config.calendarId
        ? await calendarDatesOf(config.calendarId, agent)
        : [];
      let next: Date;
      try {
        next = computeNextRunForSchedule(config, new Date(), blackoutPredicate(calendarDates));
      } catch {
        // Every rule came up dry (e.g. blackouts smother the walk): turn
        // the trigger off with the reason instead of re-firing every sweep.
        await agents.disableTrigger(
          row.triggerId,
          'No next occurrence could be found (check blackout dates); turned off.'
        );
        logger.warn(
          'a schedule of agent "{agent}" of {owner} has no next occurrence (its blackout dates cover every rule); it was turned off',
          {
            component: 'worker-agents/schedule',
            ...agent,
            triggerId: row.triggerId,
          }
        );
        continue;
      }

      // The optimistic lock: one replica advances the row, the rest lose.
      if (!(await agents.advanceScheduleTrigger(row.triggerId, observed, next))) continue;

      const result = await createAgentRun(
        producer,
        {
          agentId: row.agentId,
          ownerSubject: row.ownerSubject,
          definition: agentDefinitionOf(row),
          llmModelId: row.llmModelId,
          triggerId: row.triggerId,
          triggerKind: 'schedule',
          // Just time/date, per spec: a schedule carries no other context.
          initialState: { scheduledFor, timezone: config.timezone },
        },
        { log: (message, meta) => logger.debug(message, { ...agent, ...meta }) }
      );
      if (!result.ok) {
        const error = result.err.message ?? `The run could not be started (${result.err.type}).`;
        await agents.setTriggerError(row.triggerId, error);
        logger.warn(
          'the schedule of agent "{agent}" of {owner} came due for {scheduledFor}, but no run was started; the reason is left on the trigger: {error}',
          {
            component: 'worker-agents/schedule',
            ...agent,
            triggerId: row.triggerId,
            scheduledFor,
            error,
          }
        );
        continue;
      }
      await agents.setTriggerError(row.triggerId, null);
      logger.debug(
        'the schedule of agent "{agent}" of {owner} came due for {scheduledFor}; run {runId} was queued',
        {
          component: 'worker-agents/schedule',
          ...agent,
          triggerId: row.triggerId,
          runId: result.val.runId,
          scheduledFor,
        }
      );
    }
  };
}
