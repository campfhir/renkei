/**
 * One sub-agent run of this chat, by the code_delegate or chat_delegate
 * call that started it: its task and instructions, how far it got, its report, and its
 * whole transcript — the conversation the chat itself never carried
 * (lib/chat/subagent-runs.ts). Anyone who may read the chat may read it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { getSubagentRunByCall } from '@/lib/chat/subagent-runs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string; toolUseId: string }> }
): Promise<Response> {
  const { tenantId, chatId, toolUseId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  const run = await getSubagentRunByCall(db, tenantId, chatId, toolUseId);
  if (!run) return jsonError(404, 'not-found', 'No such sub-agent run');
  return NextResponse.json({ run });
}
