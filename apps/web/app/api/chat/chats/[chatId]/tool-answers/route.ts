/**
 * Every layer that decides tools in this chat, for its Tools dialog
 * ("Permissions"; the rule itself is lib/chat/tool-decision.ts): this
 * chat's own answers (chat-permissions.ts), its project's settings
 * (project-permissions.ts), the person's own lists for this kind of chat
 * (permission-prefs.ts, also edited under Preferences › Tool permissions),
 * the organization's locked high-risk tools, and the tools the chat can
 * be offered (reading ones flagged).
 *
 * PUT `{ tool, rule, scope }` changes one decision:
 *  - scope 'chat': rule 'allow' (an act tool runs without asking here),
 *    'ask' (a tool asks first here — a reading one made to ask), 'deny'
 *    (refused here), or 'clear' (back to whatever the layers above say);
 *  - scope 'always': rule 'allow', 'deny' or 'clear' on the person's own
 *    list for this kind of chat (every chat of that kind).
 * Allowing a tool the organization locks is refused: it asks whatever is
 * allowed. Owner only, like the card. Applies from the chat's next turn.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import {
  isChatToolRule,
  readChatToolAnswers,
  rememberChatToolAnswer,
  type ChatToolAnswers,
} from '@/lib/chat/chat-permissions';
import {
  getChatToolPermissionPrefs,
  setChatToolPermissionPrefs,
  withRule,
} from '@/lib/chat/permission-prefs';
import { TOOL_NAME, type ActToolGroup, type ChatSessionKind } from '@/lib/chat/permission-rules';
import { listChatToolGroups } from '@/lib/chat/permission-catalog';
import { chatSession } from '@/lib/chat/session-kind';
import type { ProjectToolSettings } from '@/lib/chat/project-permissions';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export interface ToolLayersAnswer {
  kind: ChatSessionKind;
  chat: ChatToolAnswers;
  /** The chat's project's settings; null outside a project. */
  project: (ProjectToolSettings & { name: string }) | null;
  /** The person's own lists for this kind of chat. */
  always: { allow: string[]; deny: string[] };
  /** The organization's locked high-risk tools. */
  locked: string[];
  /** The tools the chat can be offered, by connector; reading ones carry `read`. */
  tools: ActToolGroup[];
}

async function layers(
  session: { subject: string; roles: string[] },
  chat: { id: string; projectId: string | null }
): Promise<ToolLayersAnswer> {
  const { kind, project } = await chatSession(chat);
  const [answers, prefs, org, tools] = await Promise.all([
    readChatToolAnswers(chat.id),
    getChatToolPermissionPrefs(session.subject, { fresh: true, kind }),
    getOrgSettings(),
    listChatToolGroups(session.subject, session.roles).catch(() => []),
  ]);
  return {
    kind,
    chat: answers,
    project: project
      ? { name: project.name, ...(project.toolSettings ?? { allow: [], ask: [] }) }
      : null,
    always: { allow: prefs.alwaysAllow, deny: prefs.alwaysDeny },
    locked: org.ok ? org.val.lockedHighRiskTools : [],
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
  return NextResponse.json(await layers(ready.context.session, chat));
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
  const rule = body.rule;
  if (
    typeof body.tool !== 'string' ||
    !TOOL_NAME.test(body.tool) ||
    !scope ||
    !isChatToolRule(rule) ||
    (scope === 'always' && rule === 'ask')
  ) {
    return jsonError(
      400,
      'invalid-answer',
      "Expected tool, scope 'chat' (rule allow, ask, deny or clear) or 'always' (allow, deny or clear)"
    );
  }
  const tool = body.tool;
  if (rule === 'allow') {
    const org = await getOrgSettings();
    if (!org.ok || org.val.lockedHighRiskTools.includes(tool)) {
      return jsonError(
        409,
        'locked',
        'Your organization locks this tool as high risk, so it asks every time'
      );
    }
  }
  const { kind } = await chatSession(chat);
  if (scope === 'chat') {
    await rememberChatToolAnswer(chat.id, tool, rule);
  } else {
    const prefs = await getChatToolPermissionPrefs(session.subject, { fresh: true, kind });
    const written = await setChatToolPermissionPrefs(
      session.subject,
      withRule(prefs, tool, rule === 'clear' ? 'ask' : rule),
      kind
    );
    if (!written.ok) {
      logger.error(
        '{actor} changed {tool} ({rule}) for every {kind} chat, from chat "{chat}", but it was not saved: {error}',
        {
          component: 'api/chat/tool-answers',
          ...who(session),
          tool,
          rule,
          kind,
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
      ? '{actor} set {tool} to {rule} in chat "{chat}"'
      : '{actor} set {tool} to {rule} for every {kind} chat, from chat "{chat}"',
    {
      component: 'api/chat/tool-answers',
      ...who(session),
      tool,
      rule,
      scope,
      kind,
      chat: chat.title ?? 'Untitled chat',
      chatId: chat.id,
    }
  );
  return NextResponse.json(await layers(session, chat));
}
