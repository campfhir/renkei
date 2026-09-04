/**
 * Chats: the sidebar list and creation.
 *
 * Creating inside a project requires access to that project (any role —
 * members chat with the project's context); the chat itself is always
 * the creator's.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { createChat } from '@/lib/chat/store';
import { resolveResourceAccess } from '@/lib/chat/access';
import { parseToolConfig } from '@/lib/chat/tool-config';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json(await loadChatSidebar(db, tenantId, session.subject));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);

  let projectId: string | null = null;
  if (typeof body.projectId === 'string' && body.projectId) {
    if (!isUuid(body.projectId)) return jsonError(404, 'not-found', 'No such project');
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
  const llmModelId =
    typeof body.llmModelId === 'string' && isUuid(body.llmModelId) ? body.llmModelId : null;
  const toolConfig = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const chatId = await createChat(db, {
    tenantId,
    ownerSubject: session.subject,
    projectId,
    llmModelId,
    toolConfig,
    thinkingEnabled: body.thinkingEnabled === true,
  });
  return NextResponse.json({ chatId }, { status: 201 });
}
