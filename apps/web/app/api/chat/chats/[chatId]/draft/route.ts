/**
 * Replace the chat's unsent composer text (lib/chat/drafts.ts) with the
 * `text` in the body; empty clears it. Owner only — viewers have no box.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { MAX_DRAFT_CHARS, saveDraft } from '@/lib/chat/drafts';
import { logger } from '@/lib/logger';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveChatAccess(session.subject, chatId);
  if (!access || access.role !== 'owner') return jsonError(404, 'not-found', 'No such chat');
  const body = await readJsonBody(request);
  if (typeof body.text !== 'string' || body.text.length > MAX_DRAFT_CHARS) {
    return jsonError(400, 'invalid', 'That is not a draft the composer builds.');
  }
  try {
    const saved = await saveDraft(access.chat.id, body.text, access.cipher);
    if (!saved) {
      logger.warn('The draft could not be encrypted: the chat key is unavailable', {
        component: 'api/chat/chats/draft',
        subject: session.subject,
        chatId,
      });
      return jsonError(409, 'key-unavailable', 'The draft could not be encrypted.');
    }
  } catch (error) {
    logger.error('The draft could not be saved: {error}', {
      component: 'api/chat/chats/draft',
      subject: session.subject,
      chatId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return jsonError(500, 'database', 'The draft could not be saved.');
  }
  return NextResponse.json({ ok: true });
}
