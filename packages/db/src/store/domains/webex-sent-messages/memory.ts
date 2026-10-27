import type { MemoryTables } from '../../memory/tables';
import type { WebexSentMessageStore } from './types';

export function memoryWebexSentMessages(tables: MemoryTables): WebexSentMessageStore {
  return {
    async record(messageId, accountId) {
      tables.upsert('webex_sent_messages', { message_id: messageId, account_id: accountId }, [
        'message_id',
      ]);
    },
    async find(messageId) {
      const row = tables.first('webex_sent_messages', (r) => r.message_id === messageId);
      return row ? { messageId: row.message_id, accountId: row.account_id } : null;
    },
  };
}
