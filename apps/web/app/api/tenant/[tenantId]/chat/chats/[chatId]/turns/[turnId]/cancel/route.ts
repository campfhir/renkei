/**
 * Stop. Marks the turn (any replica's runner honors it on its next
 * heartbeat) and, when the turn runs here, aborts the in-flight request
 * at once. Owner only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { requestTurnCancel } from '@/lib/chat/turns';
import { getTurnChannel } from '@/lib/chat/turn-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; turnId: string }> }
): Promise<Response> {
  const { tenantId, chatId, turnId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const chat = await getChatForOwner(db, tenantId, session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');
  const requested = await requestTurnCancel(db, tenantId, chat.id, turnId);
  getTurnChannel(turnId)?.requestCancel();
  return NextResponse.json({ ok: true, running: requested });
}
