import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { draftFromRow, outcomeColumns } from './record';
import type { AgentDraftStore } from './types';

export function postgresAgentDrafts(db: () => Kysely<DB>): AgentDraftStore {
  return {
    async create({ ownerSubject, agentId, request }) {
      const row = await db()
        .insertInto('agent_drafts')
        .values({
          owner_subject: ownerSubject,
          agent_id: agentId,
          status: 'queued',
          request: JSON.stringify(request),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async find(ownerSubject, draftId) {
      const row = await db()
        .selectFrom('agent_drafts')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', draftId)
        .executeTakeFirst();
      return row ? draftFromRow(row) : null;
    },
    async latestReady(ownerSubject, agentId) {
      let query = db()
        .selectFrom('agent_drafts')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .where('status', '=', 'succeeded')
        .where('consumed_at', 'is', null);
      query =
        agentId === null
          ? query.where('agent_id', 'is', null)
          : query.where('agent_id', '=', agentId);
      const row = await query
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? draftFromRow(row) : null;
    },
    async consume(ownerSubject, draftId) {
      await db()
        .updateTable('agent_drafts')
        .set({ consumed_at: new Date(), updated_at: new Date() })
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', draftId)
        .execute();
    },
    async claim(draftId) {
      const result = await db()
        .updateTable('agent_drafts')
        .set({
          status: 'running',
          attempts: (eb) => eb('attempts', '+', 1),
          updated_at: new Date(),
        })
        .where('id', '=', draftId)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async finish(draftId, outcome) {
      await db()
        .updateTable('agent_drafts')
        .set(outcomeColumns(outcome, new Date()))
        .where('id', '=', draftId)
        .execute();
    },
    async delete(draftId) {
      await db().deleteFrom('agent_drafts').where('id', '=', draftId).execute();
    },
    async ownerOf(draftId) {
      const row = await db()
        .selectFrom('agent_drafts')
        .select(['owner_subject', 'agent_id'])
        .where('id', '=', draftId)
        .executeTakeFirst();
      return row ? { ownerSubject: row.owner_subject, agentId: row.agent_id } : null;
    },
    async failStuck(updatedBefore, error) {
      const rescued = await sql<{ id: string }>`
        UPDATE agent_drafts
           SET status = 'failed',
               error = ${error},
               finished_at = NOW(),
               updated_at = NOW()
         WHERE status = 'running'
           AND updated_at < ${updatedBefore}
        RETURNING id
      `.execute(db());
      return rescued.rows.length;
    },
    async pruneBefore(before, limit) {
      const pruned = await sql<{ id: string }>`
        DELETE FROM agent_drafts WHERE id IN (
          SELECT id FROM agent_drafts
           WHERE created_at < ${before}
           ORDER BY created_at, id
           LIMIT ${limit}
        ) RETURNING id
      `.execute(db());
      return pruned.rows.length;
    },
  };
}
