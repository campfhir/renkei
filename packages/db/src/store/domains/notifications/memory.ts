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
  };
}
