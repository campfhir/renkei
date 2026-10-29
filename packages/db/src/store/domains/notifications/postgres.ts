import { sql, type Kysely } from 'kysely';
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
    async markReadByRef(subject, kind, refId) {
      const result = await db()
        .updateTable('agent_notifications')
        .set({ read_at: new Date() })
        .where('subject', '=', subject)
        .where('kind', '=', kind)
        .where('ref_id', '=', refId)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
    async find(subject, id) {
      const row = await db()
        .selectFrom('agent_notifications')
        .selectAll()
        .where('subject', '=', subject)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? notificationFromRow(row) : null;
    },
    async savePushSubscription(subject, subscription) {
      await db()
        .insertInto('push_subscriptions')
        .values({
          id: globalThis.crypto.randomUUID(),
          subject,
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        })
        .onConflict((oc) =>
          oc.columns(['endpoint']).doUpdateSet({
            subject,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          })
        )
        .execute();
    },
    async deletePushSubscription(subject, endpoint) {
      const result = await db()
        .deleteFrom('push_subscriptions')
        .where('subject', '=', subject)
        .where('endpoint', '=', endpoint)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async deletePushSubscriptionByEndpoint(endpoint) {
      const result = await db()
        .deleteFrom('push_subscriptions')
        .where('endpoint', '=', endpoint)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async listPushSubscriptions(subject) {
      const rows = await db()
        .selectFrom('push_subscriptions')
        .select(['endpoint', 'p256dh', 'auth'])
        .where('subject', '=', subject)
        .orderBy('created_at')
        .orderBy('endpoint')
        .execute();
      return rows.map((row) => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
    },
    async pingChatPresence(subject, chatId, at) {
      await db()
        .insertInto('chat_presence')
        .values({ subject, chat_id: chatId, updated_at: at })
        .onConflict((oc) => oc.columns(['subject', 'chat_id']).doUpdateSet({ updated_at: at }))
        .execute();
    },
    async wasWatchingChat(subject, chatId, since) {
      const row = await db()
        .selectFrom('chat_presence')
        .select('chat_id')
        .where('subject', '=', subject)
        .where('chat_id', '=', chatId)
        .where('updated_at', '>', since)
        .executeTakeFirst();
      return row !== undefined;
    },
    async deleteChatPresenceBefore(before) {
      const result = await db()
        .deleteFrom('chat_presence')
        .where('updated_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async setHeadline(id, headline) {
      await db()
        .updateTable('agent_notifications')
        .set({ headline })
        .where('id', '=', id)
        .execute();
    },
    async pruneBefore(before, limit) {
      const deleted = await sql<{ id: string }>`
        DELETE FROM agent_notifications WHERE id IN (
          SELECT id FROM agent_notifications
          WHERE created_at < ${before}
          ORDER BY created_at, id
          LIMIT ${limit}
        ) RETURNING id
      `.execute(db());
      return deleted.rows.length;
    },
  };
}
