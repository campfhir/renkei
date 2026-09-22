/**
 * A widget card's `ui/update-model-context` (bridge.ts's `updateModelContext`)
 * — what the person did on the card, so the model's next reply knows
 * without guessing. Recorded as a note row (widget-tools.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { appendWidgetModelContext } from '@/lib/chat/widget-tools';

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

  const appended = await appendWidgetModelContext(db, { tenantId, chatId: chat.id, text });
  if (!appended.ok) {
    return appended.reason === 'turn-running'
      ? jsonError(409, 'turn-running', 'Wait for the current reply to finish first.')
      : jsonError(500, 'failed', 'The note could not be written.');
  }
  return NextResponse.json({ message: appended.message });
}
