import type { Kysely } from 'kysely';
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
  };
}
