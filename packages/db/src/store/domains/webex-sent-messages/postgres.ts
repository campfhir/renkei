import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { WebexSentMessageStore } from './types';

export function postgresWebexSentMessages(db: () => Kysely<DB>): WebexSentMessageStore {
  return {
    async record(messageId, accountId) {
      await db()
        .insertInto('webex_sent_messages')
        .values({ message_id: messageId, account_id: accountId })
        .onConflict((conflict) => conflict.columns(['message_id']).doNothing())
        .execute();
    },
    async find(messageId) {
      const row = await db()
        .selectFrom('webex_sent_messages')
        .select(['message_id', 'account_id'])
        .where('message_id', '=', messageId)
        .executeTakeFirst();
      return row ? { messageId: row.message_id, accountId: row.account_id } : null;
    },
  };
}
