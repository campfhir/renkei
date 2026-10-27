/**
 * Firing-ledger hygiene. agent_trigger_firings rows exist to make a
 * repeated delivery of one source event a no-op (packages/agents
 * event-fanout); they only need to outlive the duplicate horizon —
 * queue redelivery plus the window in which a duplicate webhook
 * registration could re-deliver an old event. A week is generous.
 * Bounded batches, the mail-jobs retention shape.
 */

import { getDataStore } from '@renkei/db';
import { logger } from '../logger';

export const AGENT_FIRINGS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Rows older than this are pruned. */
const RETENTION_DAYS = 7;
const RETENTION_BATCH = 1000;

export function createAgentFiringsSweep() {
  return async function sweep(): Promise<void> {
    const deleted = await getDataStore().agentTriggerFirings.pruneOlderThan(
      RETENTION_DAYS,
      RETENTION_BATCH
    );
    if (deleted > 0) {
      logger.info('retention pruned {count} trigger firing(s)', {
        component: 'agentfirings/sweep',
        count: deleted,
      });
    }
  };
}
