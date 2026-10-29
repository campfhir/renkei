import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { auditEventValues, platformEventFromRow, platformEventValues } from './record';
import type { AuditEventStore } from './types';

export function postgresAuditEvents(db: () => Kysely<DB>): AuditEventStore {
  return {
    async record(event) {
      await db().insertInto('audit_events').values(auditEventValues(event)).execute();
    },
    async listRecent(limit) {
      const rows = await db()
        .selectFrom('audit_events')
        .leftJoin('identities', (join) =>
          join.onRef('identities.subject', '=', 'audit_events.actor_subject')
        )
        .select([
          'audit_events.id as id',
          'audit_events.actor_subject as actor_subject',
          'audit_events.action as action',
          'audit_events.target_kind as target_kind',
          'audit_events.target_label as target_label',
          'audit_events.details as details',
          'audit_events.created_at as created_at',
          'identities.display_name as display_name',
          'identities.email as email',
        ])
        .orderBy('audit_events.created_at', 'desc')
        .orderBy('audit_events.id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        actorSubject: row.actor_subject,
        action: row.action,
        targetKind: row.target_kind,
        targetLabel: row.target_label,
        details: row.details ?? null,
        createdAt: new Date(row.created_at),
        actorDisplayName: row.display_name ?? null,
        actorEmail: row.email ?? null,
      }));
    },
    async recordPlatform(event) {
      await db().insertInto('platform_audit_log').values(platformEventValues(event)).execute();
    },
    async listPlatformFor(resourceId) {
      const rows = await db()
        .selectFrom('platform_audit_log')
        .selectAll()
        .where('resource_id', '=', resourceId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map(platformEventFromRow);
    },
  };
}
