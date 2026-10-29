import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { AgentSweepStore } from './sweep-types';

export function postgresAgentSweeps(db: () => Kysely<DB>): AgentSweepStore {
  return {
    async memoryCompactionCandidates(threshold, limit) {
      const rows = await db()
        .selectFrom('agent_memories as m')
        .innerJoin('agents as a', 'a.id', 'm.agent_id')
        .select([
          'm.agent_id as agent_id',
          'a.owner_subject as owner_subject',
          sql<string>`count(*)`.as('entries'),
        ])
        .where('m.kind', '=', 'entry')
        .groupBy(['m.agent_id', 'a.owner_subject'])
        .having(sql`count(*)`, '>', threshold)
        .orderBy(sql`count(*)`, 'desc')
        .orderBy('m.agent_id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        agentId: row.agent_id,
        ownerSubject: row.owner_subject,
        entries: Number(row.entries),
      }));
    },
    async memoryFoldSet(agentId, { keepRecent, limit }) {
      const entries = await db()
        .selectFrom('agent_memories')
        .select(['id', 'content', 'created_at'])
        .where('agent_id', '=', agentId)
        .where('kind', '=', 'entry')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(keepRecent)
        .limit(limit)
        .execute();
      if (entries.length === 0) return null;
      const summary = await db()
        .selectFrom('agent_memories')
        .select(['content'])
        .where('agent_id', '=', agentId)
        .where('kind', '=', 'summary')
        .executeTakeFirst();
      const agent = await db()
        .selectFrom('agents')
        .select(['llm_model_id'])
        .where('id', '=', agentId)
        .executeTakeFirst();
      if (!agent) return null;
      return {
        entries: entries.map((row) => ({
          id: row.id,
          content: row.content,
          createdAt: new Date(row.created_at),
        })),
        summary: summary?.content ?? null,
        llmModelId: agent.llm_model_id,
      };
    },
    async trimMemoryEntries(agentId, keep) {
      const over = await db()
        .selectFrom('agent_memories')
        .select(['id'])
        .where('agent_id', '=', agentId)
        .where('kind', '=', 'entry')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(keep)
        .execute();
      if (over.length === 0) return 0;
      const deleted = await db()
        .deleteFrom('agent_memories')
        .where(
          'id',
          'in',
          over.map((row) => row.id)
        )
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0);
    },
    async listPlaintextMemory({ afterId, sealedPrefix, limit }) {
      let query = db()
        .selectFrom('agent_memories as m')
        .innerJoin('agents as a', 'a.id', 'm.agent_id')
        .select(['m.id as id', 'm.content as content', 'a.owner_subject as owner'])
        .where(sql<boolean>`m.content NOT LIKE ${`${sealedPrefix}%`}`);
      if (afterId !== null) query = query.where('m.id', '>', afterId);
      const rows = await query.orderBy('m.id').limit(limit).execute();
      return rows.map((row) => ({ id: row.id, content: row.content, ownerSubject: row.owner }));
    },
    async replaceMemoryContent(id, expected, content) {
      const result = await db()
        .updateTable('agent_memories')
        .set({ content })
        .where('id', '=', id)
        .where('content', '=', expected)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async listDueScheduleTriggers(now, limit) {
      const rows = await db()
        .selectFrom('agent_triggers as t')
        .innerJoin('agents as a', 'a.id', 't.agent_id')
        .select([
          't.id as trigger_id',
          't.agent_id',
          't.config',
          't.next_run_at',
          'a.owner_subject',
          'a.instructions',
          'a.tools',
          'a.llm_model_id',
        ])
        .where('t.kind', '=', 'schedule')
        .where('t.enabled', '=', true)
        .where('a.enabled', '=', true)
        .where('t.next_run_at', 'is not', null)
        .where('t.next_run_at', '<=', now)
        .orderBy('t.next_run_at')
        .orderBy('t.id')
        .limit(limit)
        .execute();
      return rows.flatMap((row) =>
        row.next_run_at === null
          ? []
          : [
              {
                triggerId: row.trigger_id,
                agentId: row.agent_id,
                config: row.config,
                nextRunAt: new Date(row.next_run_at),
                ownerSubject: row.owner_subject,
                instructions: row.instructions,
                tools: row.tools,
                llmModelId: row.llm_model_id,
              },
            ]
      );
    },
    async disableTrigger(triggerId, lastError) {
      await db()
        .updateTable('agent_triggers')
        .set({ enabled: false, last_error: lastError, updated_at: sql`NOW()` })
        .where('id', '=', triggerId)
        .execute();
    },
    async advanceScheduleTrigger(triggerId, observed, next) {
      const advanced = await db()
        .updateTable('agent_triggers')
        .set({ next_run_at: next, last_fired_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', triggerId)
        .where('next_run_at', '=', observed)
        .executeTakeFirst();
      return Number(advanced.numUpdatedRows ?? 0) > 0;
    },
    async setTriggerError(triggerId, lastError) {
      await db()
        .updateTable('agent_triggers')
        .set({ last_error: lastError, updated_at: sql`NOW()` })
        .where('id', '=', triggerId)
        .execute();
    },
  };
}
