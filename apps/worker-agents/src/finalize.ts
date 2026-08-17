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
 *
 * There is deliberately NO automatic thread reply here: an agent that
 * should answer in the triggering room says so as a STEP (webex_send_message
 * with trigger.roomId/messageId), where the owner controls whether and
 * what it says — an engine-side courtesy reply was the bot era's shape.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { isAgentStepsDoc } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import type { FinalizedRun } from './engine';
import { logger } from './logger';

export function createFinalizeHook(
  db: Kysely<DB>,
  agentProducer: QueueProducer,
  eventsProducer: QueueProducer
) {
  return async function onFinalized(run: FinalizedRun): Promise<void> {
    // A quiet stop is the run ASKING for invisibility: no notification,
    // no chained agents. History still has it; nothing else.
    if (run.quiet) {
      logger.info('run {runId} stopped quietly', {
        component: 'worker-agents/finalize',
        runId: run.runId,
        tenantId: run.tenantId,
      });
      return;
    }

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
