import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { AgentTriggerFiringStore } from './types';

export function postgresAgentTriggerFirings(db: () => Kysely<DB>): AgentTriggerFiringStore {
  return {
    async claim(triggerId, dedupeKey) {
      const claimed = await db()
        .insertInto('agent_trigger_firings')
        .values({ trigger_id: triggerId, dedupe_key: dedupeKey, run_id: null })
        .onConflict((oc) => oc.columns(['trigger_id', 'dedupe_key']).doNothing())
        .returning('trigger_id')
        .executeTakeFirst();
      return claimed !== undefined;
    },
    async setRun(triggerId, dedupeKey, runId) {
      await db()
        .updateTable('agent_trigger_firings')
        .set({ run_id: runId })
        .where('trigger_id', '=', triggerId)
        .where('dedupe_key', '=', dedupeKey)
        .execute();
    },
    async release(triggerId, dedupeKey) {
      await db()
        .deleteFrom('agent_trigger_firings')
        .where('trigger_id', '=', triggerId)
        .where('dedupe_key', '=', dedupeKey)
        .execute();
    },
    async find(triggerId, dedupeKey) {
      const row = await db()
        .selectFrom('agent_trigger_firings')
        .selectAll()
        .where('trigger_id', '=', triggerId)
        .where('dedupe_key', '=', dedupeKey)
        .executeTakeFirst();
      return row
        ? {
            triggerId: row.trigger_id,
            dedupeKey: row.dedupe_key,
            runId: row.run_id,
            createdAt: new Date(row.created_at),
          }
        : null;
    },
    async pruneOlderThan(days, limit) {
      const deleted = await sql<{ trigger_id: string }>`
        DELETE FROM agent_trigger_firings WHERE (trigger_id, dedupe_key) IN (
          SELECT trigger_id, dedupe_key FROM agent_trigger_firings
          WHERE created_at < NOW() - make_interval(days => ${days})
          ORDER BY created_at, trigger_id, dedupe_key
          LIMIT ${limit}
        ) RETURNING trigger_id
      `.execute(db());
      return deleted.rows.length;
    },
  };
}
