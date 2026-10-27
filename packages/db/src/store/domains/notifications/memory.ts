import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { isEmptyTarget, notificationFromRow, notificationValues } from './record';
import type { NotificationStore, NotificationTarget } from './types';

function targets(target: NotificationTarget): (id: string) => boolean {
  if ('all' in target) return () => true;
  const ids = new Set(target.ids);
  return (id) => ids.has(id);
}

export function memoryNotifications(tables: MemoryTables): NotificationStore {
  return {
    async list(subject, { limit, since, before, unreadOnly }) {
      const rows = tables.select(
        'agent_notifications',
        (r) =>
          r.subject === subject &&
          (!since || r.created_at.getTime() > since.getTime()) &&
          (!before || r.created_at.getTime() < before.getTime()) &&
          (!unreadOnly || r.read_at === null)
      );
      return page(orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]), limit).map(
        notificationFromRow
      );
    },
    async countUnread(subject) {
      return tables.select(
        'agent_notifications',
        (r) => r.subject === subject && r.read_at === null
      ).length;
    },
    async mark(subject, target, { unread }) {
      if (isEmptyTarget(target)) return 0;
      const hit = targets(target);
      return tables.update(
        'agent_notifications',
        (r) =>
          r.subject === subject && hit(r.id) && (unread ? r.read_at !== null : r.read_at === null),
        { read_at: unread ? null : new Date() }
      ).length;
    },
    async delete(subject, target) {
      if (isEmptyTarget(target)) return 0;
      const hit = targets(target);
      return tables.delete('agent_notifications', (r) => r.subject === subject && hit(r.id)).length;
    },
    async insert(notification) {
      tables.insert('agent_notifications', notificationValues(notification));
    },
    async markReadByRef(subject, kind, refId) {
      return tables.update(
        'agent_notifications',
        (r) => r.subject === subject && r.kind === kind && r.ref_id === refId && r.read_at === null,
        { read_at: new Date() }
      ).length;
    },
    async find(subject, id) {
      const wanted = tables.param('agent_notifications', 'id', id);
      const row = tables.first(
        'agent_notifications',
        (r) => r.subject === subject && r.id === wanted
      );
      return row ? notificationFromRow(row) : null;
    },
    async savePushSubscription(subject, subscription) {
      tables.upsert(
        'push_subscriptions',
        {
          id: globalThis.crypto.randomUUID(),
          subject,
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        ['endpoint'],
        { subject, p256dh: subscription.p256dh, auth: subscription.auth }
      );
    },
    async deletePushSubscription(subject, endpoint) {
      return tables.delete(
        'push_subscriptions',
        (r) => r.subject === subject && r.endpoint === endpoint
      ).length;
    },
    async deletePushSubscriptionByEndpoint(endpoint) {
      return tables.delete('push_subscriptions', (r) => r.endpoint === endpoint).length;
    },
    async listPushSubscriptions(subject) {
      const rows = tables.select('push_subscriptions', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.created_at], [(r) => r.endpoint]).map((row) => ({
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
      }));
    },
    async pingChatPresence(subject, chatId, at) {
      tables.upsert(
        'chat_presence',
        { subject, chat_id: chatId, updated_at: at },
        ['subject', 'chat_id'],
        { updated_at: at }
      );
    },
    async wasWatchingChat(subject, chatId, since) {
      const wanted = tables.param('chat_presence', 'chat_id', chatId);
      return (
        tables.first(
          'chat_presence',
          (r) =>
            r.subject === subject &&
            r.chat_id === wanted &&
            r.updated_at.getTime() > since.getTime()
        ) !== undefined
      );
    },
    async deleteChatPresenceBefore(before) {
      return tables.delete('chat_presence', (r) => r.updated_at.getTime() < before.getTime())
        .length;
    },
    async setHeadline(id, headline) {
      const wanted = tables.param('agent_notifications', 'id', id);
      tables.update('agent_notifications', (r) => r.id === wanted, { headline });
    },
    async pruneBefore(before, limit) {
      const doomed = new Set(
        page(
          orderBy(
            tables.select('agent_notifications', (r) => r.created_at.getTime() < before.getTime()),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      return tables.delete('agent_notifications', (r) => doomed.has(r.id)).length;
    },
  };
}
