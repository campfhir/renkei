import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { WebexSentMessageStore } from './types';

export function memoryWebexSentMessages(tables: MemoryTables): WebexSentMessageStore {
  return {
    async record(messageId, accountId) {
      tables.upsert(
        'webex_sent_messages',
        { message_id: messageId, account_id: accountId, created_at: new Date() },
        ['message_id']
      );
    },
    async find(messageId) {
      const row = tables.first('webex_sent_messages', (r) => r.message_id === messageId);
      return row ? { messageId: row.message_id, accountId: row.account_id } : null;
    },
    async pruneOlderThan(days, limit) {
      const cutoff = Date.now() - days * 24 * 60 * 60_000;
      const doomed = new Set(
        page(
          orderBy(
            tables.select('webex_sent_messages', (r) => r.created_at.getTime() < cutoff),
            [(r) => r.created_at],
            [(r) => r.message_id]
          ),
          limit
        ).map((r) => r.message_id)
      );
      return tables.delete('webex_sent_messages', (r) => doomed.has(r.message_id)).length;
    },
  };
}
