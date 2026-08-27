/**
 * Recording platform actions to the tenant audit trail (migration 038).
 *
 * What belongs here: a person changing what the platform IS for them —
 * signing in or out, connecting or disconnecting a connector, creating,
 * changing or deleting an agent. What does not: using the platform. Tool
 * calls, searches and page views are usage, not audit, and adding them here
 * would drown the trail an operator actually reads.
 *
 * Recording is fire-and-forget, the same trade `usage-tracking.ts` makes: an
 * audit insert must never fail or slow the action it describes, so the write
 * is not awaited and a failure is logged rather than surfaced. The cost — a
 * lost row if the process dies mid-flight — is acceptable for a trail;
 * anything needing guaranteed capture belongs in the acting transaction.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';

export type AuditAction =
  | 'user.signed_in'
  | 'user.signed_out'
  | 'connector.connected'
  | 'connector.disconnected'
  | 'agent.created'
  | 'agent.updated'
  | 'agent.enabled'
  | 'agent.disabled'
  | 'agent.deleted'
  | 'agent.shared'
  | 'agent.unshared'
  | 'agent.copied'
  | 'settings.updated'
  | 'sanitizer.script_saved'
  | 'sanitizer.script_deleted'
  | 'fileshare.created'
  | 'fileshare.updated'
  | 'fileshare.deleted'
  | 'fileshare.connected'
  | 'fileshare.disconnected';

export interface AuditEventInput {
  tenantId: string;
  /** OIDC subject of who did it. */
  actorSubject: string | null;
  action: AuditAction;
  /** 'connector' | 'agent' — what kind of thing was acted on. */
  targetKind?: string;
  /** The thing itself: a grant provider key, an agent's name. */
  targetLabel?: string;
  /** Small structured extras (e.g. { byAdmin: true, subject }); never content. */
  details?: Record<string, unknown>;
}

export function recordAuditEvent(event: AuditEventInput): void {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;

  void dbResult.val
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      tenant_id: event.tenantId,
      actor_subject: event.actorSubject,
      action: event.action,
      target_kind: event.targetKind ?? null,
      target_label: event.targetLabel?.slice(0, 200) ?? null,
      details: event.details ? JSON.stringify(event.details) : null,
    })
    .execute()
    .catch((error: unknown) => {
      logger.warn('audit event not recorded: {action}', {
        component: 'audit',
        tenantId: event.tenantId,
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
