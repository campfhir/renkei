/**
 * SIEM export for audit events.
 *
 * Events are exported in JSON Lines format (one JSON object per line),
 * suitable for ingestion into SIEM systems. Events are ordered newest-first.
 *
 * This is an operator-only endpoint; authentication is required.
 */

import type { AdminAuditRow, AdminStore } from './admin-store.js';

export interface SiemEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type: the tool that was called */
  event_type: string;
  /** Who performed the action (account ID) */
  actor: string;
  /** Display name of the actor */
  actor_name: string | null;
  /** The outcome of the action */
  outcome: string;
  /** What was affected (issue keys) */
  target_issues: string[];
  /** Tenant ID this event belongs to */
  tenant_id: string;
}

/**
 * Convert an audit row from the database to a SIEM-compatible format.
 */
export function toSiemEvent(row: AdminAuditRow, tenantId: string): SiemEvent {
  return {
    timestamp: row.occurredAt,
    event_type: row.tool,
    actor: row.accountId,
    actor_name: row.displayName,
    outcome: row.outcome,
    target_issues: row.issueKeys,
    tenant_id: tenantId,
  };
}

/**
 * Format events as JSON Lines for SIEM ingestion.
 */
export function formatSiemEvents(events: SiemEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/**
 * Format events as Syslog (RFC 5424) for direct forwarding.
 */
export function formatSyslogs(events: SiemEvent[], hostname: string, appname = 'renkei'): string {
  return events
    .map((e) => {
      const priority = e.outcome === 'success' ? 134 : 130; // info or warning
      const msgid = e.event_type;
      const structData = `[externalData@32473 tenant_id="${e.tenant_id}" outcome="${e.outcome}"]`;
      const msg = JSON.stringify(e);
      return `<${priority}>1 ${e.timestamp} ${hostname} ${appname} - ${msgid} ${structData} ${msg}`;
    })
    .join('\n');
}

/**
 * Export audit events for SIEM ingestion.
 *
 * Called by an operator (authenticated via bearer token or cookie) to retrieve
 * events for their tenant in a format suitable for SIEM tools.
 */
export async function exportSiemEvents(
  admin: AdminStore,
  tenantId: string,
  options?: {
    /** How many events to return, default 1000 */
    limit?: number;
    /** Cursor from the previous request for pagination */
    before?: string;
    /** Format: 'json-lines' (default) or 'syslog' */
    format?: 'json-lines' | 'syslog';
    /** Hostname for Syslog format */
    hostname?: string;
  },
): Promise<{ data: string; contentType: string; nextCursor: string | undefined }> {
  const limit = options?.limit ?? 1000;
  const format = options?.format ?? 'json-lines';
  const auditLogOpts: { limit: number; before?: string } = { limit: limit + 1 };
  if (options?.before) auditLogOpts.before = options.before;
  const rows = await admin.readAuditLog(auditLogOpts);

  // Check if there are more rows (for pagination)
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      nextCursor = lastRow.occurredAt;
    }
  }

  const siemEvents = rows.map((row) => toSiemEvent(row, tenantId));

  let data: string;
  let contentType: string;

  if (format === 'syslog') {
    data = formatSyslogs(siemEvents, options?.hostname ?? 'renkei');
    contentType = 'application/x-syslog; charset=utf-8';
  } else {
    data = formatSiemEvents(siemEvents);
    contentType = 'application/x-ndjson; charset=utf-8';
  }

  return { data, contentType, nextCursor };
}
