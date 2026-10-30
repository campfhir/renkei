/**
 * One chat: read (owner or viewer), settings (owner), delete (owner).
 * `temporary` changes only while the chat is empty (lib/chat/temporary.ts).
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
import { deleteChat, getChatForOwner, updateChat, type ChatPatch } from '@/lib/chat/store';
import { deleteChatWorktree } from '@/lib/code/projects';
import { parseToolConfig } from '@/lib/chat/tool-config';
import { TEMPORARY_ONLY_WHEN_EMPTY, TEMPORARY_OUTSIDE_PROJECTS } from '@/lib/chat/temporary';

const TITLE_MAX_CHARS = 200;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveChatAccess(session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json(await loadChatView(access, session.subject));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
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
  if (typeof body.autoMode === 'boolean') patch.autoMode = body.autoMode;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;
  if (typeof body.temporary === 'boolean') {
    const chat = await getChatForOwner(session.subject, chatId);
    if (!chat) return jsonError(404, 'not-found', 'No such chat');
    if (chat.temporary !== body.temporary) {
      if (chat.lastMessageAt !== null) {
        return jsonError(409, 'not-empty', TEMPORARY_ONLY_WHEN_EMPTY);
      }
      if (body.temporary && chat.projectId) {
        return jsonError(400, 'temporary-project', TEMPORARY_OUTSIDE_PROJECTS);
      }
      patch.temporary = body.temporary;
    }
  }

  const updated = await updateChat(session.subject, chatId, patch);
  if (!updated) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const chat = await getChatForOwner(session.subject, chatId);
  const deleted = await deleteChat(session.subject, chatId);
  if (!deleted) return jsonError(404, 'not-found', 'No such chat');
  // A code chat's worktree goes with it; what this misses the worker's sweep takes.
  if (chat?.projectId) await deleteChatWorktree(chat.projectId, chat.workspaceId);
  return NextResponse.json({ ok: true });
}
