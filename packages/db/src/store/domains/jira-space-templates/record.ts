import type { Selectable } from 'kysely';
import type { JiraAdminSpaceTemplates } from '../../../db.types';
import type { JiraSpaceTemplateRecord, JiraSpaceTemplateStore } from './types';

export const JIRA_SPACE_TEMPLATES = 'jira_admin_space_templates';

export function templateFromRow(row: Selectable<JiraAdminSpaceTemplates>): JiraSpaceTemplateRecord {
  return {
    id: row.id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    name: row.name,
    nameKey: row.name_key,
    description: row.description,
    sourceSpaceKey: row.source_space_key,
    document: row.document ?? null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function templateValues(input: Parameters<JiraSpaceTemplateStore['save']>[0]) {
  return {
    cloud_id: input.cloudId,
    site_url: input.siteUrl,
    name: input.name,
    name_key: input.nameKey,
    description: input.description,
    source_space_key: input.sourceSpaceKey,
    document: JSON.stringify(input.document ?? null),
    created_by: input.subject,
    updated_by: input.subject,
  };
}
