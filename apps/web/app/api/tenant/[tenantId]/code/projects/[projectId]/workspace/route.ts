/**
 * The project's checkout: clone it (again) — after a failed clone, after
 * the worker's sweep retired it, or to point the project at another
 * repository or branch (editors; the repository change is recorded on
 * the row first). Spends the caller's own Bitbucket grant.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateGitRef, validateRepoFullName } from '@renkei/connector-sandbox';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow, updateProject } from '@/lib/chat/projects';
import { startProjectClone } from '@/lib/code/projects';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { getOrigin } from '@/lib/get-origin';
import { recordAuditEvent } from '@/lib/audit-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can clone this project’s repository.');
  let project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code') return jsonError(404, 'not-found', 'No such project');

  const body = await readJsonBody(request);
  if (typeof body.repository === 'string' || typeof body.branch === 'string') {
    const repo = validateRepoFullName(
      typeof body.repository === 'string' ? body.repository : project.repo?.fullName
    );
    if (!repo.ok) return jsonError(400, 'invalid', repo.message);
    let branch = project.repo?.branch ?? '';
    if (typeof body.branch === 'string') {
      if (!body.branch.trim()) branch = '';
      else {
        const ref = validateGitRef(body.branch);
        if (!ref.ok) return jsonError(400, 'invalid', ref.message);
        branch = ref.ref;
      }
    }
    await updateProject(db, tenantId, projectId, {
      repo: { provider: 'atlassian-bitbucket', fullName: repo.fullName, branch },
    });
    project = await getProjectRow(db, tenantId, projectId);
    if (!project) return jsonError(404, 'not-found', 'No such project');
  }

  const origin = await getOrigin(request);
  const credential = await resolveWorkspaceGitCredential(
    { tenantId, subject: session.subject, origin: origin.ok ? origin.val : '' },
    { write: false }
  );
  if (typeof credential === 'string') return jsonError(409, 'bitbucket', credential);
  const depth =
    typeof body.depth === 'number' && Number.isFinite(body.depth) ? body.depth : undefined;
  const clone = await startProjectClone(
    db,
    project,
    credential,
    depth !== undefined ? { depth } : {}
  );
  if (!clone.ok) return jsonError(clone.status, 'clone', clone.message);
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.project.cloned',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo?.fullName ?? null, workspaceId: clone.val.id },
  });
  return NextResponse.json({ workspace: clone.val });
}
