import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { auditEventValues } from './record';
import type { AuditEventStore } from './types';

export function memoryAuditEvents(tables: MemoryTables): AuditEventStore {
  return {
    async record(event) {
      tables.insert('audit_events', auditEventValues(event));
    },
    async listRecent(limit) {
      const rows = page(
        orderBy(
          tables.select('audit_events'),
          [(r) => r.created_at, 'desc'],
          [(r) => r.id, 'desc']
        ),
        limit
      );
      return rows.map((row) => {
        const identity =
          row.actor_subject === null
            ? undefined
            : tables.first('identities', (i) => i.subject === row.actor_subject);
        return {
          id: row.id,
          actorSubject: row.actor_subject,
          action: row.action,
          targetKind: row.target_kind,
          targetLabel: row.target_label,
          details: row.details ?? null,
          createdAt: row.created_at,
          actorDisplayName: identity?.display_name ?? null,
          actorEmail: identity?.email ?? null,
        };
      });
    },
  };
}
