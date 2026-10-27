/**
 * What happens after a run finishes: chained agents and the failure
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
 * should answer in the triggering room stages that reply itself
 * (webex_send_message with trigger.roomId/messageId), where the owner
 * controls whether and what it says.
 */

import { getDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { agentDefinitionOf } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import type { FinalizedRun } from './engine';
import { logger } from './logger';

export function createFinalizeHook(agentProducer: QueueProducer, eventsProducer: QueueProducer) {
  return async function onFinalized(run: FinalizedRun): Promise<void> {
    // A quiet stop is the run ASKING for invisibility: no notification,
    // no chained agents. History still has it; nothing else. A 'stopped'
    // run (nothing to do) is quiet by construction — and guarded here
    // explicitly too, because nothing was done to notify or chain from.
    // 'canceled' is the same story from the other direction: someone
    // outside the run asked it to stop, so they already know — engine.ts
    // always pairs it with quiet: true, but the status check stays here
    // as a second, explicit guard against ever chaining from one.
    if (run.quiet || run.status === 'stopped' || run.status === 'canceled') {
      logger.info('run {runId} stopped quietly', {
        component: 'worker-agents/finalize',
        runId: run.runId,
      });
      return;
    }

    if (run.status === 'failed') {
      const enqueued = await eventsProducer.enqueue({
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
    const store = getDataStore();
    const parent = await store.agentRuns.findChainLink(run.runId);
    const parentLineage = Array.isArray(parent?.lineage)
      ? parent.lineage.filter((entry): entry is string => typeof entry === 'string')
      : [];

    const finishedAgent = await store.agents.findRunSettings(run.agentId);

    const chained = await store.agents.listChainTargets(run.agentId);

    for (const trigger of chained) {
      const produced = [
        ...(run.vars.summary ? [`Its summary: ${run.vars.summary}`] : []),
        ...(run.vars.result ? [`Its result:\n${run.vars.result}`] : []),
      ].join('\n');
      const result = await createAgentRun(agentProducer, {
        agentId: trigger.agentId,
        ownerSubject: trigger.ownerSubject,
        definition: agentDefinitionOf(trigger),
        llmModelId: trigger.llmModelId,
        triggerId: trigger.triggerId,
        triggerKind: 'agent',
        parentRunId: run.runId,
        lineage: [...parentLineage, run.agentId],
        initialState: {
          parentSummary: `The agent “${finishedAgent?.name ?? run.agentId}” finished successfully.${produced ? `\n${produced}` : ''}`,
        },
      });
      if (result.ok) {
        await store.agents.markTriggerFired(trigger.triggerId);
      } else {
        await store.agents.markTriggerFailed(
          trigger.triggerId,
          result.err.message ?? `The chained run could not be started (${result.err.type}).`
        );
      }
    }
  };
}
