/**
 * A chat project's (or code project's) own tool settings for its chats
 * (lib/chat/project-permissions.ts): Allow — an act tool runs without
 * asking in the project's chats — and Ask — a tool that only reads, made
 * to ask first. Anyone the project is shared with reads them (its chats
 * follow them); its editors change them. Allowing a tool the organization
 * locks is refused: it asks whatever is allowed. A chat can still block a
 * tool or make it ask for itself (tool-decision.ts).
 *
 * PUT `{ tool, rule: 'allow' | 'ask' | 'clear' }`.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveProjectAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import {
  NO_PROJECT_TOOL_SETTINGS,
  isProjectToolRule,
  rememberProjectToolRule,
} from '@/lib/chat/project-permissions';
import { TOOL_NAME } from '@/lib/chat/permission-rules';
import { listChatToolGroups } from '@/lib/chat/permission-catalog';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

async function answer(
  session: { subject: string; roles: string[] },
  projectId: string,
  canEdit: boolean
) {
  const [project, org, tools] = await Promise.all([
    getProjectRow(projectId),
    getOrgSettings(),
    listChatToolGroups(session.subject, session.roles).catch(() => []),
  ]);
  return {
    settings: project?.toolSettings ?? NO_PROJECT_TOOL_SETTINGS,
    locked: org.ok ? org.val.lockedHighRiskTools : [],
    tools,
    canEdit,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const access = await resolveProjectAccess(ready.context.session.subject, projectId);
  if (!access) return jsonError(404, 'not-found', 'No such project');
  return NextResponse.json(
    await answer(ready.context.session, projectId, access.role !== 'viewer')
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveProjectAccess(session.subject, projectId);
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer') {
    return jsonError(403, 'read-only', 'Only editors can change this project.');
  }
  const body = await readJsonBody(request);
  if (
    typeof body.tool !== 'string' ||
    !TOOL_NAME.test(body.tool) ||
    !isProjectToolRule(body.rule)
  ) {
    return jsonError(400, 'invalid-setting', "Expected tool and rule 'allow', 'ask' or 'clear'");
  }
  const tool = body.tool;
  const rule = body.rule;
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
  const project = await getProjectRow(projectId);
  const stored = await rememberProjectToolRule(projectId, tool, rule);
  if (!stored) return jsonError(404, 'not-found', 'No such project');
  logger.info('{actor} set {tool} to {rule} for the chats of project "{project}"', {
    component: 'api/chat/projects/tool-permissions',
    ...who(session),
    tool,
    rule,
    project: project?.name ?? 'Untitled project',
    projectId,
  });
  return NextResponse.json(await answer(session, projectId, true));
}
