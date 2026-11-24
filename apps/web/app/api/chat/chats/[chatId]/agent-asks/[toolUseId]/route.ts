/**
 * What an agent the chat asked (chat_ask_agent, lib/chat/agent-asks.ts)
 * is doing, and its reply once it has one — by the call that asked it.
 * Anyone who may read the chat may read it: the reply is part of the chat.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { readAskByCall } from '@/lib/chat/agent-asks';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string; toolUseId: string }> }
): Promise<Response> {
  const { chatId, toolUseId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveChatAccess(session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  const ask = await readAskByCall(chatId, toolUseId);
  if (!ask) return jsonError(404, 'not-found', 'No agent was asked by that call');
  return NextResponse.json({ ask });
}
