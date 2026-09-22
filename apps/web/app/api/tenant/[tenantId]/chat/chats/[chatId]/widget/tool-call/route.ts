/**
 * A widget card's confirm button, run for real: the host component
 * (widget-card.tsx) proxies the card's `tools/call` postMessage here.
 * Owner only, like every other action a card's card could take on the
 * chat's behalf — a shared chat's viewer watches, the owner acts
 * (chat-thread.tsx's banner says as much already).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { confirmWidgetTool } from '@/lib/chat/widget-tools';

const MAX_ARGS_CHARS = 20_000;

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
  const name = typeof body.name === 'string' ? body.name : '';
  const args: Record<string, unknown> = {};
  if (
    typeof body.arguments === 'object' &&
    body.arguments !== null &&
    !Array.isArray(body.arguments)
  ) {
    for (const [key, value] of Object.entries(body.arguments)) args[key] = value;
  }
  if (!name || JSON.stringify(args).length > MAX_ARGS_CHARS) {
    return jsonError(400, 'invalid', 'A tool name and arguments are required.');
  }

  const outcome = await confirmWidgetTool(db, {
    tenantId,
    subject: session.subject,
    roles: session.roles,
    name,
    arguments: args,
  });
  if (!outcome.ok) {
    return outcome.reason === 'not-a-card-tool'
      ? jsonError(403, 'not-a-card-tool', 'That tool is not a card action.')
      : jsonError(502, 'call-failed', 'The tool could not be reached.');
  }
  return NextResponse.json({ result: outcome.result });
}
