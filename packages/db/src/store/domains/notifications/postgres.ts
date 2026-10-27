import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { isEmptyTarget, notificationFromRow, notificationValues } from './record';
import type { NotificationStore } from './types';

export function postgresNotifications(db: () => Kysely<DB>): NotificationStore {
  return {
    async list(subject, { limit, since, before, unreadOnly }) {
      let query = db()
        .selectFrom('agent_notifications')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit);
      if (since) query = query.where('created_at', '>', since);
      if (before) query = query.where('created_at', '<', before);
      if (unreadOnly) query = query.where('read_at', 'is', null);
      return (await query.execute()).map(notificationFromRow);
    },
    async countUnread(subject) {
      const row = await db()
        .selectFrom('agent_notifications')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },
    async mark(subject, target, { unread }) {
      if (isEmptyTarget(target)) return 0;
      let update = db()
        .updateTable('agent_notifications')
        .set({ read_at: unread ? null : new Date() })
        .where('subject', '=', subject)
        .where('read_at', unread ? 'is not' : 'is', null);
      if ('ids' in target) update = update.where('id', 'in', target.ids);
      const result = await update.executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async delete(subject, target) {
      if (isEmptyTarget(target)) return 0;
      let del = db().deleteFrom('agent_notifications').where('subject', '=', subject);
      if ('ids' in target) del = del.where('id', 'in', target.ids);
      const result = await del.executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async insert(notification) {
      await db()
        .insertInto('agent_notifications')
        .values(notificationValues(notification))
        .execute();
    },
  };
}
