/**
 * Replace the chat's queued sends (lib/chat/queued-sends.ts) with the
 * list in the body — the whole list, so the last write wins and a send
 * that has gone out cannot come back. Owner only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { parseQueue, saveQueuedSends } from '@/lib/chat/queued-sends';

export async function PUT(
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
  const queue = parseQueue(body.queue);
  if (!queue) return jsonError(400, 'invalid', 'That is not a queue the composer builds.');
  try {
    await saveQueuedSends(db, tenantId, chat.id, queue);
  } catch {
    return jsonError(500, 'database', 'The queue could not be saved.');
  }
  return NextResponse.json({ ok: true });
}
