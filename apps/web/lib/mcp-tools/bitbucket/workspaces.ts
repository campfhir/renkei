/**
 * The workspaces the connected person belongs to — one reader for the
 * bitbucket_list_workspaces tool and the Code pages' repository browser,
 * so the two cannot drift onto different endpoints again.
 *
 * /user/workspaces, not bare /workspaces: the latter is deprecated AND
 * refuses the newer JWT-shaped tokens with an anonymous-style 404
 * (observed in the field on a token every workspace-scoped endpoint
 * accepted — the new-project form read "Resource not found" off it while
 * the tool, already moved, listed the same workspace fine). Each row is a
 * workspace_access wrapper carrying an administrator flag alongside the
 * workspace itself. Belt and braces for token types the primary will not
 * take: the permissions listing answers the same question with the
 * caller's permission per row; only if both refuse does the primary's
 * error surface.
 */

import type { BitbucketAuth } from './bitbucket-auth';
import { bbJson, rec, str, values } from './client';

const MAX_WORKSPACES = 50;

export interface UserWorkspace {
  slug: string;
  name: string;
  /** From the membership listing; absent when the fallback answered. */
  administrator?: boolean;
  /** From the permissions listing; absent when the primary answered. */
  permission?: string;
}

export async function listUserWorkspaces(
  auth: BitbucketAuth,
  scopes: readonly string[]
): Promise<{ ok: true; workspaces: UserWorkspace[] } | { ok: false; error: string }> {
  const primary = await bbJson(auth, scopes, `/user/workspaces?pagelen=${MAX_WORKSPACES}`);
  if (primary.ok) {
    return {
      ok: true,
      workspaces: rows(primary.body, (row) =>
        row.administrator === true ? { administrator: true } : {}
      ),
    };
  }
  const fallback = await bbJson(
    auth,
    scopes,
    `/user/permissions/workspaces?pagelen=${MAX_WORKSPACES}`
  );
  if (!fallback.ok) return primary;
  return {
    ok: true,
    workspaces: rows(fallback.body, (row) =>
      str(row.permission) ? { permission: str(row.permission) } : {}
    ),
  };
}

function rows(
  body: Record<string, unknown>,
  extra: (row: Record<string, unknown>) => Partial<UserWorkspace>
): UserWorkspace[] {
  const workspaces: UserWorkspace[] = [];
  for (const row of values(body)) {
    const workspace = rec(row.workspace);
    const slug = str(workspace.slug);
    if (slug) workspaces.push({ slug, name: str(workspace.name) || slug, ...extra(row) });
  }
  return workspaces;
}
