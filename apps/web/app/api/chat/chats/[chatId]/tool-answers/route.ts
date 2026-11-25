/**
 * Every decision that applies to tools in this chat, for its Tools dialog
 * ("Decided here"): what the owner allowed or blocked for this chat alone
 * from its permission cards (chat-permissions.ts), what they allowed or
 * blocked always (permission-prefs.ts, also edited under Preferences ›
 * Tool permissions), and which of those tools the organization locks
 * (they ask whatever was allowed). A tool on none of these lists asks
 * every time.
 *
 * PUT `{ tool, rule: 'ask', scope: 'chat' | 'always' }` takes one decision
 * back: off this chat's lists, or off the person's own (which changes
 * every chat of theirs, as Preferences would). It is the way out of a
 * block, since a blocked tool is never offered to the chat again and so
 * never raises a card. Only taking back: allowing goes through the card,
 * which knows about the organization's locks. Owner only, like the card.
 * Applies from the chat's next turn.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { readChatToolAnswers, rememberChatToolAnswer } from '@/lib/chat/chat-permissions';
import {
  getChatToolPermissionPrefs,
  setChatToolPermissionPrefs,
  withRule,
} from '@/lib/chat/permission-prefs';
import { TOOL_NAME } from '@/lib/chat/permission-rules';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export interface ToolDecisionsAnswer {
  chat: { allow: string[]; deny: string[] };
  always: { allow: string[]; deny: string[] };
  /** The listed tools the organization locks as high risk. */
  locked: string[];
}

async function decisions(subject: string, chatId: string): Promise<ToolDecisionsAnswer> {
  const [chat, prefs, org] = await Promise.all([
    readChatToolAnswers(chatId),
    getChatToolPermissionPrefs(subject, { fresh: true }),
    getOrgSettings(),
  ]);
  const listed = new Set([...chat.allow, ...chat.deny, ...prefs.alwaysAllow, ...prefs.alwaysDeny]);
  return {
    chat,
    always: { allow: prefs.alwaysAllow, deny: prefs.alwaysDeny },
    locked: (org.ok ? org.val.lockedHighRiskTools : []).filter((name) => listed.has(name)).sort(),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const chat = await getChatForOwner(ready.context.session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');
  return NextResponse.json(await decisions(ready.context.session.subject, chat.id));
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
  const scope = body.scope === 'always' ? 'always' : body.scope === 'chat' ? 'chat' : null;
  if (
    typeof body.tool !== 'string' ||
    !TOOL_NAME.test(body.tool) ||
    body.rule !== 'ask' ||
    !scope
  ) {
    return jsonError(
      400,
      'invalid-answer',
      "Expected tool, rule 'ask' and scope 'chat' or 'always'"
    );
  }
  const tool = body.tool;
  if (scope === 'chat') {
    await rememberChatToolAnswer(chat.id, tool, 'ask');
  } else {
    const prefs = await getChatToolPermissionPrefs(session.subject, { fresh: true });
    const written = await setChatToolPermissionPrefs(session.subject, withRule(prefs, tool, 'ask'));
    if (!written.ok) {
      logger.error(
        '{actor} put {tool} back to asking in every chat, from chat "{chat}", but it was not saved: {error}',
        {
          component: 'api/chat/tool-answers',
          ...who(session),
          tool,
          chat: chat.title ?? 'Untitled chat',
          chatId: chat.id,
          error: written.err.message ?? written.err.type,
        }
      );
      return jsonError(500, 'save-failed', 'Could not save');
    }
  }
  logger.info(
    scope === 'chat'
      ? '{actor} put {tool} back to asking in chat "{chat}"'
      : '{actor} put {tool} back to asking in every chat, from chat "{chat}"',
    {
      component: 'api/chat/tool-answers',
      ...who(session),
      tool,
      scope,
      chat: chat.title ?? 'Untitled chat',
      chatId: chat.id,
    }
  );
  return NextResponse.json(await decisions(session.subject, chat.id));
}
