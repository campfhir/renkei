import type { Selectable } from 'kysely';
import type { PlatformAuditLog } from '../../../db.types';
import type { NewAuditEvent, NewPlatformAuditEvent, PlatformAuditEventRecord } from './types';

export function auditEventValues(event: NewAuditEvent) {
  return {
    id: event.id,
    actor_subject: event.actorSubject,
    action: event.action,
    target_kind: event.targetKind,
    target_label: event.targetLabel,
    details: event.details === null ? null : JSON.stringify(event.details),
    ...(event.createdAt ? { created_at: event.createdAt } : {}),
  };
}

export function platformEventValues(event: NewPlatformAuditEvent) {
  return {
    id: event.id,
    event_type: event.eventType,
    actor_id: event.actorId,
    resource_id: event.resourceId,
    details: event.details === null ? null : JSON.stringify(event.details),
  };
}

export function platformEventFromRow(row: Selectable<PlatformAuditLog>): PlatformAuditEventRecord {
  return {
    id: row.id,
    eventType: row.event_type,
    actorId: row.actor_id,
    resourceId: row.resource_id,
    details: row.details ?? null,
    createdAt: new Date(row.created_at),
  };
}
