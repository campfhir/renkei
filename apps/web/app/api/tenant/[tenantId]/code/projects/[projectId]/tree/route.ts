/**
 * One directory of the project's checkout, for the tree on its page:
 * entries with kind and size, directories first. Any member may look;
 * the page asks for each folder as it is opened.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientFailure, sandboxWorkspacesEnabled, sbWorkspaceLs } from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { codeProjectTarget } from '@/lib/code/scope';

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
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code') return jsonError(404, 'not-found', 'No such project');
  if (!sandboxWorkspacesEnabled() || !project.workspaceId) {
    return jsonError(409, 'not-cloned', 'The repository is not cloned.');
  }
  const path = new URL(request.url).searchParams.get('path') ?? '';
  const listed = await sbWorkspaceLs(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    path,
  });
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return jsonError(failure.status, 'tree', failure.message);
  }
  const entries = [...listed.val.entries].sort((a, b) => {
    const rank = (kind: string) => (kind === 'dir' ? 0 : 1);
    return rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path);
  });
  return NextResponse.json({ path: listed.val.path, entries });
}
