import type { Selectable } from 'kysely';
import type { SandboxWorkspaces } from '../../../db.types';
import type { SandboxWorkspaceRecord } from './types';

export function sandboxWorkspaceFromRow(
  row: Selectable<SandboxWorkspaces>
): SandboxWorkspaceRecord {
  return {
    id: row.id,
    subject: row.subject,
    provider: row.provider,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    storageKey: row.storage_key,
    parentId: row.parent_id,
    status: row.status,
    error: row.error,
    sizeBytes: Number(row.size_bytes),
    createdAt: new Date(row.created_at),
    lastUsedAt: new Date(row.last_used_at),
    expiresAt: new Date(row.expires_at),
  };
}

export function sandboxWorkspaceValues(
  workspace: Parameters<import('./types').SandboxWorkspaceStore['insert']>[0]
) {
  return {
    id: workspace.id,
    subject: workspace.subject,
    provider: workspace.provider,
    repo_full_name: workspace.repoFullName,
    branch: workspace.branch,
    storage_key: workspace.storageKey,
    parent_id: workspace.parentId,
    status: workspace.status,
    expires_at: workspace.expiresAt,
  };
}

/** The optional size and branch of an update, as columns. */
export function sizeAndBranch(change: { sizeBytes?: number; branch?: string }) {
  return {
    ...(change.sizeBytes !== undefined ? { size_bytes: change.sizeBytes } : {}),
    ...(change.branch !== undefined ? { branch: change.branch } : {}),
  };
}
