/**
 * What happens after a run's last step: chained agents and the failure
 * notification event.
 *
 * Chaining is authorized on the TARGET — agent B runs after agent A only
 * because B's owner attached an "after A" trigger — and guarded in
 * createAgentRun: the child's lineage carries every ancestor agent id, so
 * A→B→A refuses at the second A, and depth stops at the org's ceiling. A
 * refused chain lands on the target trigger's last_error, where its owner
 * looks.
 *
 * Failures become an ordinary `agents/run.failed` event on the interactive
 * queue: notification delivery (owner's Outlook mail, WebEx DM) belongs to
 * the interactive worker, which owns those connector paths.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { isAgentStepsDoc } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import type { FinalizedRun } from './engine';
import { logger } from './logger';

/**
 * The bot's thread reply for a WebEx-triggered run. The room and thread
 * come from the run's own initial state; the wording is the owner's when a
 * step saved its result as `reply`, a plain outcome line otherwise.
 */
async function enqueueThreadReply(
  db: Kysely<DB>,
  eventsProducer: QueueProducer,
  run: FinalizedRun
): Promise<void> {
  const row = await db
    .selectFrom('agent_runs as r')
    .leftJoin('agent_triggers as t', 't.id', 'r.trigger_id')
    .select(['r.initial_state', 't.kind', 't.event_source', 't.config'])
    .where('r.id', '=', run.runId)
    .executeTakeFirst();
  if (!row || row.kind !== 'event' || row.event_source !== 'webex') return;

  const config: { replyInThread?: unknown } =
    typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
      ? row.config
      : {};
  if (config.replyInThread === false) return;

  const state: { roomId?: unknown; messageId?: unknown } =
    typeof row.initial_state === 'object' &&
    row.initial_state !== null &&
    !Array.isArray(row.initial_state)
      ? row.initial_state
      : {};
  if (typeof state.roomId !== 'string' || typeof state.messageId !== 'string') return;

  const agent = await db
    .selectFrom('agents')
    .select('name')
    .where('id', '=', run.agentId)
    .executeTakeFirst();
  const name = agent?.name ?? 'Your agent';

  const markdown =
    run.status === 'succeeded'
      ? (run.vars.reply ?? `✅ **${name}** finished.`)
      : `⚠️ **${name}** couldn't finish${run.error ? `: ${run.error}` : '.'}`;

  const enqueued = await eventsProducer.enqueue({
    tenantId: run.tenantId,
    source: 'agents',
    type: 'run.reply',
    payload: { roomId: state.roomId, parentId: state.messageId, markdown },
  });
  if (!enqueued.ok) {
    logger.warn('could not enqueue thread reply for run {runId}', {
      component: 'worker-agents/finalize',
      runId: run.runId,
    });
  }
}

export function createFinalizeHook(
  db: Kysely<DB>,
  agentProducer: QueueProducer,
  eventsProducer: QueueProducer
) {
  return async function onFinalized(run: FinalizedRun): Promise<void> {
    // Success or failure, a WebEx-triggered run answers in its thread —
    // silence in the room is the confusing outcome, not the failure.
    await enqueueThreadReply(db, eventsProducer, run);

    if (run.status === 'failed') {
      const enqueued = await eventsProducer.enqueue({
        tenantId: run.tenantId,
        source: 'agents',
        type: 'run.failed',
        payload: {
          runId: run.runId,
          agentId: run.agentId,
          ownerSubject: run.ownerSubject,
          errorKind: run.errorKind,
        },
      });
      if (!enqueued.ok) {
        logger.warn('could not enqueue run.failed for {runId}', {
          component: 'worker-agents/finalize',
          runId: run.runId,
        });
      }
      return;
    }

    // The parent run's chain state seeds the children's guards.
    const parent = await db
      .selectFrom('agent_runs')
      .select(['lineage'])
      .where('id', '=', run.runId)
      .executeTakeFirst();
    const parentLineage = Array.isArray(parent?.lineage)
      ? parent.lineage.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const finishedAgent = await db
      .selectFrom('agents')
      .select('name')
      .where('id', '=', run.agentId)
      .executeTakeFirst();

    const chained = await db
      .selectFrom('agent_triggers as t')
      .innerJoin('agents as a', 'a.id', 't.agent_id')
      .select(['t.id as trigger_id', 't.agent_id', 'a.owner_subject', 'a.steps', 'a.llm_model_id'])
      .where('t.tenant_id', '=', run.tenantId)
      .where('t.kind', '=', 'agent')
      .where('t.enabled', '=', true)
      .where('a.enabled', '=', true)
      .where(sql<string>`t.config->>'callerAgentId'`, '=', run.agentId)
      .execute();

    for (const trigger of chained) {
      if (!isAgentStepsDoc(trigger.steps)) continue;
      const varLines = Object.entries(run.vars)
        .map(([name, value]) => `${name}: ${value}`)
        .join('; ');
      const result = await createAgentRun(db, agentProducer, {
        tenantId: run.tenantId,
        agentId: trigger.agent_id,
        ownerSubject: trigger.owner_subject,
        steps: trigger.steps,
        llmModelId: trigger.llm_model_id,
        triggerId: trigger.trigger_id,
        triggerKind: 'agent',
        parentRunId: run.runId,
        lineage: [...parentLineage, run.agentId],
        initialState: {
          parentSummary: `The agent “${finishedAgent?.name ?? run.agentId}” finished successfully.${varLines ? ` It produced: ${varLines}` : ''}`,
        },
      });
      if (result.ok) {
        await db
          .updateTable('agent_triggers')
          .set({ last_fired_at: sql`NOW()`, last_error: null, updated_at: sql`NOW()` })
          .where('id', '=', trigger.trigger_id)
          .execute();
      } else {
        await db
          .updateTable('agent_triggers')
          .set({
            last_error:
              result.err.message ?? `The chained run could not be started (${result.err.type}).`,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', trigger.trigger_id)
          .execute();
      }
    }
  };
}
