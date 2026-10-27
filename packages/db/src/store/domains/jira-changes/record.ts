import type { Selectable } from 'kysely';
import type { JiraAdminChangeRequests } from '../../../db.types';
import type { JiraChangeRecord } from './types';

export const JIRA_CHANGES = 'jira_admin_change_requests';

const date = (value: Date | string) => new Date(value);
const maybeDate = (value: Date | string | null) => (value ? new Date(value) : null);

export function jiraChangeFromRow(row: Selectable<JiraAdminChangeRequests>): JiraChangeRecord {
  return {
    id: row.id,
    subject: row.subject,
    agentId: row.agent_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    payload: row.payload ?? null,
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
