/**
 * What the owner decided about tools for this one chat, from its
 * permission card ("Allow in this chat", "Block in this chat";
 * chat-permissions.ts): read by the chat's Tools dialog, and taken back
 * from there. PUT `{ tool, rule: 'ask' }` puts one tool back to asking —
 * the way out of "Block in this chat", since a blocked tool is never
 * offered to the chat again and so never raises a card to answer. Owner
 * only, like the card. Applies from the chat's next turn.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { readChatToolAnswers, rememberChatToolAnswer } from '@/lib/chat/chat-permissions';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const chat = await getChatForOwner(ready.context.session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json(await readChatToolAnswers(chat.id));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const chat = await getChatForOwner(session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');

  const body = await readJsonBody(request);
  // Only taking a decision back: allowing goes through the card, which
  // knows whether the organization locks the tool.
  if (typeof body.tool !== 'string' || body.rule !== 'ask') {
    return jsonError(400, 'invalid-answer', "Expected tool and rule 'ask'");
  }
  const stored = await rememberChatToolAnswer(chat.id, body.tool, 'ask');
  if (!stored) return jsonError(400, 'invalid-answer', 'Not a tool name');
  logger.info('{actor} put {tool} back to asking in chat "{chat}"', {
    component: 'api/chat/tool-answers',
    ...who(session),
    tool: body.tool,
    chat: chat.title ?? 'Untitled chat',
    chatId: chat.id,
  });
  return NextResponse.json(stored);
}
