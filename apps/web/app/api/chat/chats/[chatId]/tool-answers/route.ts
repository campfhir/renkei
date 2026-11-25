/**
 * Every decision that applies to tools in this chat, for its Tools dialog
 * ("Decided here"): what the owner allowed or blocked for this chat alone
 * from its permission cards (chat-permissions.ts), what they allowed or
 * blocked always (permission-prefs.ts, also edited under Preferences ›
 * Tool permissions), and which of those tools the organization locks
 * (they ask whatever was allowed). A tool on none of these lists asks
 * every time.
 *
 * It also lists the tools the chat can be offered (reading ones flagged),
 * for the dialog's "Block a tool".
 *
 * PUT `{ tool, rule: 'ask' | 'deny', scope: 'chat' | 'always' }` takes one
 * decision back, or blocks a tool: on this chat's lists, or on the
 * person's own (which changes every chat of theirs, as Preferences
 * would). Taking back is the way out of a block, since a blocked tool is
 * never offered to the chat again and so never raises a card. Blocking
 * here is the only way, beside Preferences, to block a tool that only
 * reads: it never asks, so no card offers it. Allowing goes through the
 * card, which knows about the organization's locks. Owner only, like the
 * card. Applies from the chat's next turn.
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
import { TOOL_NAME, type ActToolGroup } from '@/lib/chat/permission-rules';
import { listChatToolGroups } from '@/lib/chat/permission-catalog';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export interface ToolDecisionsAnswer {
  chat: { allow: string[]; deny: string[] };
  always: { allow: string[]; deny: string[] };
  /** The listed tools the organization locks as high risk. */
  locked: string[];
  /** The tools the chat can be offered, by connector; reading ones carry `read`. */
  tools: ActToolGroup[];
}

async function decisions(
  session: { subject: string; roles: string[] },
  chatId: string
): Promise<ToolDecisionsAnswer> {
  const subject = session.subject;
  const [chat, prefs, org, tools] = await Promise.all([
    readChatToolAnswers(chatId),
    getChatToolPermissionPrefs(subject, { fresh: true }),
    getOrgSettings(),
    listChatToolGroups(subject, session.roles).catch(() => []),
  ]);
  const listed = new Set([...chat.allow, ...chat.deny, ...prefs.alwaysAllow, ...prefs.alwaysDeny]);
  return {
    chat,
    always: { allow: prefs.alwaysAllow, deny: prefs.alwaysDeny },
    locked: (org.ok ? org.val.lockedHighRiskTools : []).filter((name) => listed.has(name)).sort(),
    tools,
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
  return NextResponse.json(await decisions(ready.context.session, chat.id));
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
    (body.rule !== 'ask' && body.rule !== 'deny') ||
    !scope
  ) {
    return jsonError(
      400,
      'invalid-answer',
      "Expected tool, rule 'ask' or 'deny', and scope 'chat' or 'always'"
    );
  }
  const tool = body.tool;
  const rule: 'ask' | 'deny' = body.rule;
  if (scope === 'chat') {
    await rememberChatToolAnswer(chat.id, tool, rule);
  } else {
    const prefs = await getChatToolPermissionPrefs(session.subject, { fresh: true });
    const written = await setChatToolPermissionPrefs(session.subject, withRule(prefs, tool, rule));
    if (!written.ok) {
      logger.error(
        '{actor} changed {tool} in every chat ({rule}), from chat "{chat}", but it was not saved: {error}',
        {
          component: 'api/chat/tool-answers',
          ...who(session),
          tool,
          rule,
          chat: chat.title ?? 'Untitled chat',
          chatId: chat.id,
          error: written.err.message ?? written.err.type,
        }
      );
      return jsonError(500, 'save-failed', 'Could not save');
    }
  }
  logger.info(
    rule === 'deny'
      ? scope === 'chat'
        ? '{actor} blocked {tool} in chat "{chat}"'
        : '{actor} blocked {tool} in every chat, from chat "{chat}"'
      : scope === 'chat'
        ? '{actor} put {tool} back to asking in chat "{chat}"'
        : '{actor} put {tool} back to asking in every chat, from chat "{chat}"',
    {
      component: 'api/chat/tool-answers',
      ...who(session),
      tool,
      rule,
      scope,
      chat: chat.title ?? 'Untitled chat',
      chatId: chat.id,
    }
  );
  return NextResponse.json(await decisions(session, chat.id));
}
