/**
 * A widget card's `ui/update-model-context` (bridge.ts's `updateModelContext`)
 * — what the person did on the card. Recorded as a note row AND, when the
 * chat can take one, the user row of a new turn (widget-tools.ts), so the
 * model replies to the decision the way it would to a message: the
 * response carries the note for the thread and the turn's ids to stream
 * from, exactly as Send's does (turns/route.ts), or `turn: null` when
 * only the note could be written.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { recordWidgetModelContext } from '@/lib/chat/widget-tools';

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
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return jsonError(400, 'invalid', 'text is required.');

  const recorded = await recordWidgetModelContext(db, {
    tenantId,
    session: { subject: session.subject, roles: session.roles },
    chatId: chat.id,
    text,
  });
  if (!recorded.ok) {
    return recorded.reason === 'turn-running'
      ? jsonError(409, 'turn-running', 'Wait for the current reply to finish first.')
      : jsonError(500, 'failed', 'The note could not be written.');
  }
  return NextResponse.json(
    { message: recorded.message, turn: recorded.turn },
    { status: recorded.turn ? 202 : 200 }
  );
}
