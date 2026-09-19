/**
 * Which branch a code project's checkout is on, without a worker call:
 * the sandbox worker keeps `sandbox_workspaces.branch` current on every
 * git verb (workspace-endpoints.ts touches it after status, diff,
 * commit, push and pull), and the row lives in the same database. So
 * the app menu and a chat's title bar can name the branch from a read,
 * for every code project at once. Only a usable checkout answers; a
 * project not cloned yet, or whose clone failed, has no branch to name.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';

/** The branch per workspace id, for the ready ones among those asked about. */
export async function workspaceBranches(
  db: Kysely<DB>,
  tenantId: string,
  workspaceIds: (string | null)[]
): Promise<Map<string, string>> {
  const ids = [...new Set(workspaceIds.filter((id): id is string => !!id && isUuid(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('sandbox_workspaces')
    .select(['id', 'branch'])
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', ids)
    .where('status', '=', 'ready')
    .execute();
  return new Map(rows.filter((row) => row.branch).map((row) => [row.id, row.branch]));
}
