/** Take an agent off a chat project's team: the owner or an editor, whoever's agent it is. */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { listProjectTeam, removeFromProjectTeam } from '@/lib/chat/agent-asks';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; agentId: string }> }
): Promise<Response> {
  const { projectId, agentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = isUuid(projectId)
    ? await resolveResourceAccess(session.subject, 'chat_project', projectId)
    : null;
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer') {
    return jsonError(403, 'read-only', 'Only the project’s owner and editors can change its team.');
  }
  const removed = await removeFromProjectTeam(session.subject, projectId, agentId);
  if (!removed.ok) return jsonError(removed.status, 'not-found', removed.message);
  return NextResponse.json({ team: await listProjectTeam(session.subject, projectId) });
}
