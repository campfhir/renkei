/**
 * Resend a prompt, as it was or edited, removing every reply after it.
 * Answers 202 with the new turn's ids plus what was removed, so the page
 * can drop those rows without a reload.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { USER_MESSAGE_MAX_CHARS } from '@/lib/chat/start-turn';
import { resendFromMessage } from '@/lib/chat/resend';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; messageId: string }> }
): Promise<Response> {
  const { tenantId, chatId, messageId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);

  const text = typeof body.text === 'string' ? body.text : null;
  if (text !== null && text.length > USER_MESSAGE_MAX_CHARS) {
    return jsonError(
      413,
      'too-long',
      `Messages are limited to ${USER_MESSAGE_MAX_CHARS} characters.`
    );
  }
  const extraAttachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === 'string' && isUuid(id))
    : [];
  const llmModelId =
    typeof body.llmModelId === 'string' && isUuid(body.llmModelId) ? body.llmModelId : null;

  const resent = await resendFromMessage(db, {
    tenantId,
    session: { subject: session.subject, roles: session.roles },
    chatId,
    messageId,
    text,
    extraAttachmentIds,
    llmModelId,
  });
  if (!resent.ok) {
    switch (resent.err.type) {
      case 'NOT_FOUND':
        return jsonError(404, 'not-found', 'No such message');
      case 'NOT_PROMPT':
        return jsonError(400, 'not-a-prompt', 'Only your own messages can be resent.');
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
          'No model is configured for this organization. An administrator can add one under Models.'
        );
      case 'MODEL_ERROR':
        return jsonError(409, 'model-error', resent.err.message ?? 'The model is not usable.');
      case 'CONTENT_KEY':
        return jsonError(500, 'content-key', 'The content encryption key is not configured.');
      default:
        return jsonError(500, 'database', 'The message could not be resent.');
    }
  }
  return NextResponse.json(resent.val, { status: 202 });
}
