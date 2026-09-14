/**
 * One code project: its page data (any member — the checkout's state and
 * the environment's names ride along) and its deletion (owner), which
 * takes the checkout and the variables on the sandbox worker with it.
 * Name, instructions, toolset and sharing go through the chat project
 * route it is built on (…/chat/projects/[projectId]).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { loadCodeProjectView } from '@/lib/code/project-view';
import { deleteCodeProject } from '@/lib/code/projects';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
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
  const view = await loadCodeProjectView(db, tenantId, session.subject, projectId, access);
  if (!view) return jsonError(404, 'not-found', 'No such project');
  return NextResponse.json(view);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const project = await getProjectRow(db, tenantId, projectId);
  const deleted = project
    ? await deleteCodeProject(db, tenantId, session.subject, projectId)
    : false;
  if (!deleted || !project) return jsonError(404, 'not-found', 'No such project');
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.project.deleted',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo?.fullName ?? null },
  });
  return NextResponse.json({ ok: true });
}
