import type { NewAuditEvent } from './types';

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
