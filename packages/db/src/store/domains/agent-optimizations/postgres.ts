import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { optimizationFromRow, outcomeColumns } from './record';
import type { AgentOptimizationStore } from './types';

export function postgresAgentOptimizations(db: () => Kysely<DB>): AgentOptimizationStore {
  return {
    async create({ ownerSubject, agentId, request }) {
      const row = await db()
        .insertInto('agent_optimizations')
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
    async find(ownerSubject, optimizationId) {
      const row = await db()
        .selectFrom('agent_optimizations')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', optimizationId)
        .executeTakeFirst();
      return row ? optimizationFromRow(row) : null;
    },
    async latest(ownerSubject, agentId) {
      const row = await db()
        .selectFrom('agent_optimizations')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .where('agent_id', '=', agentId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? optimizationFromRow(row) : null;
    },
    async inFlight(agentId) {
      const row = await db()
        .selectFrom('agent_optimizations')
        .select('id')
        .where('agent_id', '=', agentId)
        .where('status', 'in', ['queued', 'running'])
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .executeTakeFirst();
      return row ?? null;
    },
    async claim(optimizationId) {
      const result = await db()
        .updateTable('agent_optimizations')
        .set({
          status: 'running',
          attempts: (eb) => eb('attempts', '+', 1),
          updated_at: new Date(),
        })
        .where('id', '=', optimizationId)
        .where('status', '=', 'queued')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async finish(optimizationId, outcome) {
      await db()
        .updateTable('agent_optimizations')
        .set(outcomeColumns(outcome, new Date()))
        .where('id', '=', optimizationId)
        .execute();
    },
    async markApplied(ownerSubject, optimizationId, draftId) {
      await db()
        .updateTable('agent_optimizations')
        .set({
          result: sql`COALESCE(result, '{}'::jsonb) || ${JSON.stringify({ draftId })}::jsonb`,
          applied_at: new Date(),
          updated_at: new Date(),
        })
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', optimizationId)
        .execute();
    },
    async delete(optimizationId) {
      await db().deleteFrom('agent_optimizations').where('id', '=', optimizationId).execute();
    },
    async ownerOf(optimizationId) {
      const row = await db()
        .selectFrom('agent_optimizations')
        .select(['owner_subject', 'agent_id'])
        .where('id', '=', optimizationId)
        .executeTakeFirst();
      return row ? { ownerSubject: row.owner_subject, agentId: row.agent_id } : null;
    },
    async failStuck(updatedBefore, error) {
      const rescued = await sql<{ id: string }>`
        UPDATE agent_optimizations
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
        DELETE FROM agent_optimizations WHERE id IN (
          SELECT id FROM agent_optimizations
           WHERE created_at < ${before}
           ORDER BY created_at, id
           LIMIT ${limit}
        ) RETURNING id
      `.execute(db());
      return pruned.rows.length;
    },
  };
}
