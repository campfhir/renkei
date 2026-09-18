/**
 * Where a notification opens when clicked from outside the app — the OS
 * banner's click, which arrives at the row's open route rather than at a
 * rendered card. The same precedence the notifications page applies to a
 * card's primary link (notifications-list.tsx), written down once so a
 * banner and a card land in the same place:
 *
 *   the source application, when the row links to one and the person
 *   wants that (`openInSourceApp`); else in Renkei — the row's own in-app
 *   link (a chat), the batch or agent it is about, the run it came from,
 *   or failing all of those the notifications page.
 *
 * Pure and client-safe: no database, no Node imports.
 */

import { isExternalNotificationUrl } from '@renkei/notifications';
import {
  batchNotificationHref,
  isBatchNotificationKind,
  parseBatchNotificationMeta,
} from './batch-meta';

export interface NotificationTargetRow {
  kind: string;
  refUrl: string | null;
  agentId: string | null;
  runId: string | null;
  meta: unknown;
}

export interface NotificationTarget {
  url: string;
  /** Outside Renkei — the provider's own link. */
  external: boolean;
}

/** The row's home inside Renkei, whatever the preference says. */
export function notificationInAppPath(slug: string, row: NotificationTargetRow): string {
  if (row.refUrl && row.refUrl.startsWith('/') && !row.refUrl.startsWith('//')) return row.refUrl;
  if (isBatchNotificationKind(row.kind)) {
    const batch = parseBatchNotificationMeta(row.meta);
    if (batch) return batchNotificationHref(slug, batch);
  }
  if (
    (row.kind === 'agent_edited' || row.kind === 'agent_disabled' || row.kind === 'agent_shared') &&
    row.agentId
  ) {
    return `/${slug}/agents/${row.agentId}`;
  }
  if (row.runId && row.agentId) return `/${slug}/agents/${row.agentId}/runs/${row.runId}`;
  return `/${slug}/notifications`;
}

export function notificationTarget(
  slug: string,
  row: NotificationTargetRow,
  openInSourceApp: boolean
): NotificationTarget {
  if (openInSourceApp && isExternalNotificationUrl(row.refUrl)) {
    return { url: row.refUrl, external: true };
  }
  return { url: notificationInAppPath(slug, row), external: false };
}
