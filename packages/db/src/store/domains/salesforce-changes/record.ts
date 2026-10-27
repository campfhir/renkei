import type { Selectable } from 'kysely';
import type { SalesforceAdminChangeRequests } from '../../../db.types';
import type { SalesforceChangeRecord } from './types';

export const SALESFORCE_CHANGES = 'salesforce_admin_change_requests';

const date = (value: Date | string) => new Date(value);
const maybeDate = (value: Date | string | null) => (value ? new Date(value) : null);

export function salesforceChangeFromRow(
  row: Selectable<SalesforceAdminChangeRequests>
): SalesforceChangeRecord {
  return {
    id: row.id,
    subject: row.subject,
    agentId: row.agent_id,
    connectorKey: row.connector_key,
    orgId: row.org_id,
    instanceUrl: row.instance_url,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    payload: row.payload ?? null,
    validation: row.validation ?? null,
    status: row.status,
    results: row.results ?? null,
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    appliedBy: row.applied_by,
    appliedAt: maybeDate(row.applied_at),
    cancelledAt: maybeDate(row.cancelled_at),
    approvedBy: row.approved_by,
    approvedAt: maybeDate(row.approved_at),
    step: row.step,
    resolution: row.resolution,
  };
}

/** A JSON column's value as pg is handed it: JSON text (an array would go as a Postgres array). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
