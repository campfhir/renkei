import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { postgresChatTurnEngine } from './engine-postgres';
import { messageFromRow, summaryFromRow, turnFromRow } from './record';
import type { ChatThreadStore } from './types';

export function postgresChatThreads(db: () => Kysely<DB>): ChatThreadStore {
  return {
    ...postgresChatTurnEngine(db),
    async listMessages(chatId) {
      const rows = await db()
        .selectFrom('chat_messages')
        .selectAll()
        .where('chat_id', '=', chatId)
        .orderBy('seq', 'asc')
        .execute();
      return rows.map(messageFromRow);
    },
    async listTurnMessages(turnId) {
      const rows = await db()
        .selectFrom('chat_messages')
        .selectAll()
        .where('turn_id', '=', turnId)
        .orderBy('seq', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(messageFromRow);
    },
    async getActiveTurn(chatId) {
      const row = await db()
        .selectFrom('chat_turns')
        .selectAll()
        .where('chat_id', '=', chatId)
        .where('status', '=', 'running')
        .orderBy('started_at', 'desc')
        .orderBy('id')
        .executeTakeFirst();
      return row ? turnFromRow(row) : null;
    },
    async getTurn(chatId, turnId) {
      const row = await db()
        .selectFrom('chat_turns')
        .selectAll()
        .where('chat_id', '=', chatId)
        .where('id', '=', turnId)
        .executeTakeFirst();
      return row ? turnFromRow(row) : null;
    },
    async latestSummary(chatId) {
      const row = await db()
        .selectFrom('chat_summaries')
        .selectAll()
        .where('chat_id', '=', chatId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? summaryFromRow(row) : null;
    },
    async listWidgetDecisions(chatId) {
      const rows = await db()
        .selectFrom('chat_widget_decisions')
        .select(['state_key', 'state'])
        .where('chat_id', '=', chatId)
        .orderBy('state_key')
        .execute();
      return rows.map((row) => ({ stateKey: row.state_key, state: row.state }));
    },
    async getWidgetDecision(stateKey) {
      const row = await db()
        .selectFrom('chat_widget_decisions')
        .select('state')
        .where('state_key', '=', stateKey)
        .executeTakeFirst();
      return row ? row.state : null;
    },
    async getDraft(chatId) {
      const row = await db()
        .selectFrom('chat_drafts')
        .select('content')
        .where('chat_id', '=', chatId)
        .executeTakeFirst();
      return row?.content ?? null;
    },
    async saveDraft(chatId, sealed) {
      await db()
        .insertInto('chat_drafts')
        .values({ chat_id: chatId, content: sealed })
        .onConflict((oc) =>
          oc.column('chat_id').doUpdateSet({ content: sealed, updated_at: new Date() })
        )
        .execute();
    },
    async deleteDraft(chatId) {
      await db().deleteFrom('chat_drafts').where('chat_id', '=', chatId).execute();
    },
    async getQueue(chatId) {
      const row = await db()
        .selectFrom('chat_queued_sends')
        .select('queue')
        .where('chat_id', '=', chatId)
        .executeTakeFirst();
      return row ? row.queue : null;
    },
    async saveQueue(chatId, queue) {
      const json = JSON.stringify(queue);
      await db()
        .insertInto('chat_queued_sends')
        .values({ chat_id: chatId, queue: json })
        .onConflict((oc) =>
          oc.columns(['chat_id']).doUpdateSet({ queue: json, updated_at: new Date() })
        )
        .execute();
    },
    async deleteQueue(chatId) {
      await db().deleteFrom('chat_queued_sends').where('chat_id', '=', chatId).execute();
    },
    async interruptStaleTurns(staleBefore, error) {
      // stale_since/stage are read from the pre-update row (the CTE), not
      // the NOW() this same statement writes over it with.
      const stale = await sql<{
        id: string;
        chat_id: string;
        stage: string | null;
        stale_since: Date;
      }>`
        WITH targets AS (
          SELECT id, chat_id, stage, updated_at
            FROM chat_turns
           WHERE status = 'running'
             AND updated_at < ${staleBefore}
        )
        UPDATE chat_turns t
           SET status = 'interrupted',
               error = ${error},
               finished_at = NOW(),
               updated_at = NOW()
          FROM targets
         WHERE t.id = targets.id
        RETURNING t.id, targets.chat_id, targets.stage, targets.updated_at AS stale_since
      `.execute(db());
      if (stale.rows.length === 0) return [];
      await db()
        .updateTable('chat_messages')
        .set({ status: 'interrupted', updated_at: sql<Date>`NOW()` })
        .where(
          'turn_id',
          'in',
          stale.rows.map((row) => row.id)
        )
        .where('status', '=', 'streaming')
        .execute();
      return stale.rows
        .map((row) => ({
          id: row.id,
          chatId: row.chat_id,
          stage: row.stage,
          staleSince: new Date(row.stale_since),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
