import type { Selectable } from 'kysely';
import type { ResourceAccessGrants } from '../../../db.types';
import type { GrantResourceKind, ResourceGrantRecord } from './types';

export function grantFromRow(row: Selectable<ResourceAccessGrants>): ResourceGrantRecord {
  return {
    id: row.id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    ownerSubject: row.owner_subject,
    granteeSubject: row.grantee_subject,
    role: row.role,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    createdAt: new Date(row.created_at),
  };
}

/** The table a resource of this kind lives in. */
export function tableOfKind(
  kind: GrantResourceKind
): 'chats' | 'chat_projects' | 'artifacts' | 'prompt_libraries' {
  return kind === 'chat'
    ? 'chats'
    : kind === 'chat_project'
      ? 'chat_projects'
      : kind === 'artifact'
        ? 'artifacts'
        : 'prompt_libraries';
}
