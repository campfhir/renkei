/**
 * Send. Creates the turn and answers 202 with the ids the page streams
 * from; the model work runs after the response (start-turn.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { startChatTurn, USER_MESSAGE_MAX_CHARS } from '@/lib/chat/start-turn';
import { attachmentPromptBlocks } from '@/lib/chat/attachments';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);

  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > USER_MESSAGE_MAX_CHARS) {
    return jsonError(
      413,
      'too-long',
      `Messages are limited to ${USER_MESSAGE_MAX_CHARS} characters.`
    );
  }
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
    : [];
  const llmModelId =
    typeof body.llmModelId === 'string' && isUuid(body.llmModelId) ? body.llmModelId : null;

  const extraBlocks =
    attachmentIds.length > 0
      ? await attachmentPromptBlocks(db, tenantId, session.subject, chatId, attachmentIds)
      : [];

  const started = await startChatTurn(db, {
    tenantId,
    session: { subject: session.subject, roles: session.roles },
    chatId,
    text,
    extraBlocks,
    attachmentIds,
    llmModelId,
  });
  if (!started.ok) {
    switch (started.err.type) {
      case 'NOT_FOUND':
        return jsonError(404, 'not-found', 'No such chat');
      case 'FORBIDDEN':
        return jsonError(403, 'read-only', 'Only the owner can continue this chat.');
      case 'EMPTY':
        return jsonError(400, 'empty', 'Write something first.');
      case 'TOO_LONG':
        return jsonError(413, 'too-long', 'The message is too long.');
      case 'ALREADY_RUNNING':
        return jsonError(409, 'turn-running', 'A reply is already in progress.');
      case 'NO_MODEL':
        return jsonError(
          409,
          'no-model',
          'No model is configured for this organization. An administrator can add one under Agent models.'
        );
      case 'MODEL_ERROR':
        return jsonError(409, 'model-error', started.err.message ?? 'The model is not usable.');
      case 'CONTENT_KEY':
        return jsonError(500, 'content-key', 'The content encryption key is not configured.');
      default:
        return jsonError(500, 'database', 'The message could not be saved.');
    }
  }
  return NextResponse.json(started.val, { status: 202 });
}
