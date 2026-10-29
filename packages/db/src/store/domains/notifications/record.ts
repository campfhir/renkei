import type { Selectable } from 'kysely';
import type { AgentNotifications } from '../../../db.types';
import type { NotificationRecord, NotificationTarget } from './types';

export function notificationFromRow(row: Selectable<AgentNotifications>): NotificationRecord {
  return {
    id: row.id,
    subject: row.subject,
    kind: row.kind,
    category: row.category,
    connector: row.connector,
    tool: row.tool,
    entity: row.entity,
    headline: row.headline,
    refUrl: row.ref_url,
    agentId: row.agent_id,
    agentName: row.agent_name,
    runId: row.run_id,
    meta: row.meta ?? null,
    readAt: row.read_at ? new Date(row.read_at) : null,
    createdAt: new Date(row.created_at),
  };
}

export function notificationValues(
  notification: Parameters<import('./types').NotificationStore['insert']>[0]
) {
  return {
    id: notification.id,
    subject: notification.subject,
    kind: notification.kind,
    category: notification.category,
    connector: notification.connector,
    tool: notification.tool,
    entity: notification.entity,
    headline: notification.headline,
    ref_url: notification.refUrl,
    ...(notification.refId !== undefined ? { ref_id: notification.refId } : {}),
    ...(notification.stepId !== undefined ? { step_id: notification.stepId } : {}),
    agent_id: notification.agentId,
    agent_name: notification.agentName,
    run_id: notification.runId,
    meta:
      notification.meta === null || notification.meta === undefined
        ? null
        : JSON.stringify(notification.meta),
    read_at: notification.readAt ?? null,
    ...(notification.createdAt ? { created_at: notification.createdAt } : {}),
  };
}

/** `where id in ()` is a syntax error in Postgres; an empty id list reaches nothing anyway. */
export function isEmptyTarget(target: NotificationTarget): boolean {
  return 'ids' in target && target.ids.length === 0;
}
