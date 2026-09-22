/**
 * The lines every code-project route starts with, once: the session and
 * database, the person's access to the project (404 for none, never
 * 403), the project row as a code project, and — for a write — the
 * editor role, the feature switch, and the org's read-only mode. The
 * older routes (tree, diff, env) spell these out themselves; the code
 * pane's routes share them here.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess, type ResourceAccess } from '@/lib/chat/access';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import type { Session } from '@/lib/session';

export interface CodeProjectContext {
  db: Kysely<DB>;
  session: Session;
  access: ResourceAccess;
  project: ProjectRow;
}

export async function codeProjectContext(
  request: NextRequest,
  tenantId: string,
  projectId: string,
  options: { write?: boolean } = {}
): Promise<{ ok: true; context: CodeProjectContext } | { ok: false; response: NextResponse }> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready;
  const { db, session } = ready.context;
  if (options.write && !sandboxWorkspacesEnabled()) {
    return {
      ok: false,
      response: jsonError(
        503,
        'unavailable',
        'Code workspaces are not enabled on this deployment.'
      ),
    };
  }
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return { ok: false, response: jsonError(404, 'not-found', 'No such project') };
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code' || !project.repo) {
    return { ok: false, response: jsonError(404, 'not-found', 'No such project') };
  }
  if (options.write) {
    if (access.role === 'viewer') {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'Only editors can change this project’s repository.'),
      };
    }
    const settings = await getOrgSettings(tenantId);
    if (settings.ok && settings.val.readOnly) {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'The organization is in read-only mode.'),
      };
    }
  }
  return { ok: true, context: { db, session, access, project } };
}
