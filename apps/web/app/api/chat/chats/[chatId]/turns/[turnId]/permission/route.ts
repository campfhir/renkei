/**
 * Answer the tool call a turn is parked behind: allow it once, in this
 * chat, or always; deny it once, block it in this chat, or block it
 * always. Owner only — the one person who can send the chat a message is
 * the one person who can let it act.
 *
 * A tool the organization locks as high risk can only be allowed once:
 * "in this chat" and "always" would stop it asking, which the lock exists
 * to prevent, so they are refused (the card does not offer them).
 *
 * Three writes, in the order that keeps each safe on its own: an answer
 * that outlasts the call goes first — onto the person's preferences
 * ("always", "block always") or the chat ("in this chat") — durable even
 * if the turn dies before it runs the call, then the answer onto the turn
 * row (what any
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
import { getOrgSettings } from '@renkei/settings';
import { allowChatToolAlways, blockChatToolAlways } from '@/lib/chat/permission-prefs';
import { rememberChatToolAnswer } from '@/lib/chat/chat-permissions';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { markChatToolPermissionRead } from '@/lib/chat/permission-notification';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string; turnId: string }> }
): Promise<Response> {
  const { chatId, turnId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const chat = await getChatForOwner(session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');

  const body = await readJsonBody(request);
  const toolUseId = typeof body.toolUseId === 'string' ? body.toolUseId.slice(0, 200) : '';
  const decision = body.decision;
  if (!toolUseId || !isToolPermissionDecision(decision)) {
    return jsonError(400, 'invalid-decision', 'Expected toolUseId and a decision');
  }

  const turn = await getTurn(chat.id, turnId);
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

  if (decision === 'always' || decision === 'chat') {
    const settings = await getOrgSettings();
    // Unreadable settings: refuse the lasting allow rather than risk
    // lifting a lock — "allow once" still works.
    const locked = !settings.ok || settings.val.lockedHighRiskTools.includes(pending.name);
    if (locked) {
      return jsonError(
        409,
        'locked',
        'Your organization locks this tool as high risk, so it can only be allowed once'
      );
    }
  }

  if (decision === 'always' || decision === 'deny-always') {
    const remembered =
      decision === 'always'
        ? await allowChatToolAlways(session.subject, pending.name)
        : await blockChatToolAlways(session.subject, pending.name);
    if (!remembered.ok) {
      return jsonError(
        remembered.err.type === 'INVALID_NAME' ? 400 : 500,
        'not-remembered',
        'Could not save the permission'
      );
    }
  }

  if (decision === 'chat' || decision === 'deny-chat') {
    const remembered = await rememberChatToolAnswer(
      chat.id,
      pending.name,
      decision === 'chat' ? 'allow' : 'deny'
    ).catch((error: unknown) => {
      logger.error(
        '{actor} answered "{decision}" for {tool} in chat {chatId}, but it was not saved on the chat; the call waits on: {error}',
        {
          component: 'api/chat/permission',
          ...who(session),
          decision,
          tool: pending.name,
          chatId: chat.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return false;
    });
    if (!remembered) return jsonError(500, 'not-remembered', 'Could not save the permission');
  }

  const written = await decideToolPermission(chat.id, turnId, toolUseId, decision);
  if (!written) return jsonError(409, 'not-pending', 'The chat is no longer waiting on this call');
  getTurnChannel(turnId)?.resolveToolPermission(toolUseId, decision);
  // The ask is answered — its notification row need not stay unread.
  await markChatToolPermissionRead(session.subject, toolUseId);

  return NextResponse.json({ ok: true, decision });
}
