/**
 * A chat project's team (lib/chat/agent-asks.ts): the agents its chats
 * offer first. Any member reads it; an editor or the owner adds an agent
 * they may ask themselves — their own, or one shared with them.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { addToProjectTeam, listProjectTeam } from '@/lib/chat/agent-asks';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = isUuid(projectId)
    ? await resolveResourceAccess(session.subject, 'chat_project', projectId)
    : null;
  if (!access) return jsonError(404, 'not-found', 'No such project');
  return NextResponse.json({ team: await listProjectTeam(session.subject, projectId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
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
  const body = await readJsonBody(request);
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const added = await addToProjectTeam(session.subject, projectId, agentId);
  if (!added.ok) {
    return jsonError(added.status, added.status === 409 ? 'already' : 'not-found', added.message);
  }
  return NextResponse.json(
    { team: await listProjectTeam(session.subject, projectId) },
    { status: 201 }
  );
}
