/**
 * One chat: read (owner or viewer), settings (owner), delete (owner).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { loadChatView } from '@/lib/chat/chat-view';
import { deleteChat, updateChat, type ChatPatch } from '@/lib/chat/store';
import { parseToolConfig } from '@/lib/chat/tool-config';

const TITLE_MAX_CHARS = 200;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json(await loadChatView(db, tenantId, access, session.subject));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);

  const patch: ChatPatch = {};
  const title = optionalString(body.title, TITLE_MAX_CHARS);
  if (title !== undefined) patch.title = title || null;
  if (body.llmModelId === null) patch.llmModelId = null;
  else if (typeof body.llmModelId === 'string') {
    if (!isUuid(body.llmModelId)) return jsonError(400, 'invalid', 'Invalid model');
    patch.llmModelId = body.llmModelId;
  }
  if (body.toolConfig === null) patch.toolConfig = null;
  else if (body.toolConfig !== undefined) {
    const parsed = parseToolConfig(body.toolConfig);
    if (!parsed) return jsonError(400, 'invalid', 'Invalid tool configuration');
    patch.toolConfig = parsed;
  }
  if (typeof body.thinkingEnabled === 'boolean') patch.thinkingEnabled = body.thinkingEnabled;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;

  const updated = await updateChat(db, tenantId, session.subject, chatId, patch);
  if (!updated) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const deleted = await deleteChat(db, tenantId, session.subject, chatId);
  if (!deleted) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json({ ok: true });
}
