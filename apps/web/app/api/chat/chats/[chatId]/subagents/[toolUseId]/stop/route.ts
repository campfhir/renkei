/**
 * Stop one sub-agent that is still working, by the delegating call that
 * started it (lib/chat/subagent-stops.ts): the rest of the turn, and any
 * other sub-agent, carries on. Owner only — a viewer of a shared chat
 * reads a run, and stops nothing.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { stopSubagent } from '@/lib/chat/subagent-stops';
import { who } from '@/lib/log-actor';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string; toolUseId: string }> }
): Promise<Response> {
  const { chatId, toolUseId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const chat = await getChatForOwner(session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');
  const actor = who(session);
  const running = await stopSubagent(
    chat.id,
    toolUseId,
    `stopped by ${actor.user ?? 'the person'}`
  );
  logger.info(
    running
      ? '{actor} stopped a sub-agent of their chat'
      : '{actor} asked to stop a sub-agent of their chat that had already finished; nothing was stopped',
    { component: 'chat/subagent', ...actor, chatId: chat.id, toolUseId }
  );
  return NextResponse.json({ ok: true, running });
}
