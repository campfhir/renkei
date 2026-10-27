import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { userMemoryFromRow } from './postgres';
import type { UserMemoryStore } from './types';

export function memoryUserMemory(tables: MemoryTables): UserMemoryStore {
  const rowsOf = (ownerSubject: string) =>
    orderBy(
      tables.select('chat_user_memories', (r) => r.owner_subject === ownerSubject),
      [(r) => r.created_at, 'desc'],
      [(r) => r.id]
    );
  const memoryId = (value: string) => tables.param('chat_user_memories', 'id', value);

  return {
    async list(ownerSubject, limit) {
      return page(rowsOf(ownerSubject), limit).map(userMemoryFromRow);
    },
    async append(entry) {
      const inserted = tables.insert('chat_user_memories', {
        owner_subject: entry.ownerSubject,
        kind: 'entry',
        content: entry.content,
        chat_id: entry.chatId,
      });
      const beyond = new Set(
        rowsOf(entry.ownerSubject)
          .filter((r) => r.kind === 'entry')
          .slice(entry.keep)
          .map((r) => r.id)
      );
      tables.delete('chat_user_memories', (r) => beyond.has(r.id));
      return inserted.id;
    },
    async edit(ownerSubject, id, content) {
      const wanted = memoryId(id);
      return (
        tables.update(
          'chat_user_memories',
          (r) => r.owner_subject === ownerSubject && r.id === wanted && r.kind === 'entry',
          { content, updated_at: new Date() }
        ).length > 0
      );
    },
    async forget(ownerSubject, target) {
      if (target.kind === 'entries' && target.ids.length === 0) return 0;
      const ids = target.kind === 'entries' ? new Set(target.ids.map(memoryId)) : null;
      return tables.delete(
        'chat_user_memories',
        (r) => r.owner_subject === ownerSubject && (!ids || ids.has(r.id))
      ).length;
    },
  };
}
