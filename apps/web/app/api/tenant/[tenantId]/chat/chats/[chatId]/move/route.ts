/**
 * Move a chat into a project, or back out (`projectId: null`). Owner
 * only; the target project must be one the owner can open; not while a
 * reply is in progress, since the running turn already built its context.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getChatForOwner, moveChatToProject } from '@/lib/chat/store';
import { getActiveTurn } from '@/lib/chat/turns';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const chat = await getChatForOwner(db, tenantId, session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');

  const body = await readJsonBody(request);
  let projectId: string | null = null;
  if (body.projectId !== null && body.projectId !== undefined) {
    if (typeof body.projectId !== 'string' || !isUuid(body.projectId)) {
      return jsonError(404, 'not-found', 'No such project');
    }
    const access = await resolveResourceAccess(
      db,
      tenantId,
      session.subject,
      'chat_project',
      body.projectId
    );
    if (!access) return jsonError(404, 'not-found', 'No such project');
    projectId = body.projectId;
  }
  if (await getActiveTurn(db, chat.id)) {
    return jsonError(409, 'turn-running', 'Wait for the current reply to finish first.');
  }
  await moveChatToProject(db, tenantId, session.subject, chat.id, projectId);
  return NextResponse.json({ ok: true, projectId });
}
