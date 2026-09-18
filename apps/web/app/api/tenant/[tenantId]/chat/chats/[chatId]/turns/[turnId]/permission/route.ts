/**
 * Allow once, always allow, or deny the tool call a turn is parked behind.
 * Owner only — the one person who can send the chat a message is the one
 * person who can let it act.
 *
 * Three writes, in the order that keeps each safe on its own: "always"
 * goes to the person's preferences first (durable even if the turn dies
 * before it runs the call), then the answer onto the turn row (what any
 * replica's runner polls), then the channel (the fast path when the turn
 * runs here). A decision for a call the turn is no longer waiting on —
 * answered from another tab, or the ask timed out — is a 409, not a
 * silent no-op, so the page can refresh rather than sit on a stale card.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { decideToolPermission, getTurn, isToolPermissionDecision } from '@/lib/chat/turns';
import { getTurnChannel } from '@/lib/chat/turn-events';
import { allowChatToolAlways } from '@/lib/chat/permission-prefs';
import { markChatToolPermissionRead } from '@/lib/chat/permission-notification';

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

  const body = await readJsonBody(request);
  const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId.slice(0, 200) : '';
  const decision = body.decision;
  if (!toolUseId || !isToolPermissionDecision(decision)) {
    return jsonError(400, 'invalid-decision', 'Expected toolUseId and a decision');
  }

  const turn = await getTurn(db, tenantId, chat.id, turnId);
  if (!turn) return jsonError(404, 'not-found', 'No such turn');
  const pending = turn.toolPermission;
  if (
    turn.status !== 'running' ||
    !pending ||
    pending.toolUseId !== toolUseId ||
    pending.decision !== null
  ) {
    return jsonError(409, 'not-pending', 'The chat is no longer waiting on this call');
  }

  if (decision === 'always') {
    const remembered = await allowChatToolAlways(tenantId, session.subject, pending.name);
    if (!remembered.ok) {
      return jsonError(
        remembered.err.type === 'INVALID_NAME' ? 400 : 500,
        'not-remembered',
        'Could not save the permission'
      );
    }
  }

  const written = await decideToolPermission(db, tenantId, chat.id, turnId, toolUseId, decision);
  if (!written) return jsonError(409, 'not-pending', 'The chat is no longer waiting on this call');
  getTurnChannel(turnId)?.resolveToolPermission(toolUseId, decision);
  // The ask is answered — its notification row need not stay unread.
  await markChatToolPermissionRead(tenantId, session.subject, toolUseId);

  return NextResponse.json({ ok: true, decision });
}
