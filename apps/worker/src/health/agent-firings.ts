/**
 * Firing-ledger hygiene. agent_trigger_firings rows exist to make a
 * repeated delivery of one source event a no-op (packages/agents
 * event-fanout); they only need to outlive the duplicate horizon —
 * queue redelivery plus the window in which a duplicate webhook
 * registration could re-deliver an old event. A week is generous.
 * Bounded batches, the mail-jobs retention shape.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '../logger';

export const AGENT_FIRINGS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Rows older than this are pruned. */
const RETENTION_DAYS = 7;
const RETENTION_BATCH = 1000;

export function createAgentFiringsSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const deleted = await sql<{ trigger_id: string }>`
      DELETE FROM agent_trigger_firings WHERE (trigger_id, dedupe_key) IN (
        SELECT trigger_id, dedupe_key FROM agent_trigger_firings
        WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${RETENTION_BATCH}
      ) RETURNING trigger_id
    `.execute(db);
    if (deleted.rows.length > 0) {
      logger.info('retention pruned {count} trigger firing(s)', {
        component: 'agentfirings/sweep',
        count: deleted.rows.length,
      });
    }
  };
}
