import { sql, type Kysely, type Selectable } from 'kysely';
import type { ChatUserMemories, DB } from '../../../db.types';
import type { UserMemoryRecord, UserMemoryStore } from './types';

export function userMemoryFromRow(row: Selectable<ChatUserMemories>): UserMemoryRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    kind: row.kind,
    content: row.content,
    chatId: row.chat_id,
    createdAt: new Date(row.created_at),
  };
}

export function postgresUserMemory(db: () => Kysely<DB>): UserMemoryStore {
  return {
    async list(ownerSubject, limit) {
      const rows = await db()
        .selectFrom('chat_user_memories')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(userMemoryFromRow);
    },
    async append(entry) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const inserted = await trx
            .insertInto('chat_user_memories')
            .values({
              owner_subject: entry.ownerSubject,
              kind: 'entry',
              content: entry.content,
              chat_id: entry.chatId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await sql`
            DELETE FROM chat_user_memories
             WHERE owner_subject = ${entry.ownerSubject} AND kind = 'entry'
               AND id IN (
                 SELECT id FROM chat_user_memories
                  WHERE owner_subject = ${entry.ownerSubject} AND kind = 'entry'
                  ORDER BY created_at DESC, id OFFSET ${entry.keep}
               )
          `.execute(trx);
          return inserted.id;
        });
    },
    async edit(ownerSubject, id, content) {
      const result = await db()
        .updateTable('chat_user_memories')
        .set({ content, updated_at: sql<Date>`NOW()` })
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', id)
        .where('kind', '=', 'entry')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async forget(ownerSubject, target) {
      if (target.kind === 'entries' && target.ids.length === 0) return 0;
      let query = db().deleteFrom('chat_user_memories').where('owner_subject', '=', ownerSubject);
      if (target.kind === 'entries') query = query.where('id', 'in', target.ids);
      const result = await query.executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
