/**
 * Code projects: the ones this person can open, and creation. Creating
 * one is a chat project with a repository on it: the row is written and
 * the `.env` (if pasted) goes to the sandbox worker under the project's
 * scope. Nothing is cloned yet — the first chat in the project clones
 * the repository with the chatting person's own grant on the chosen
 * git host (Bitbucket or GitHub).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateGitRef, validateRepoFullName } from '@renkei/connector-sandbox';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import {
  createProject,
  getProjectRow,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
} from '@/lib/chat/projects';
import {
  CODE_PROJECT_CONNECTORS,
  defaultToolConfig,
  parseToolConfig,
  withRequiredConnectors,
} from '@/lib/chat/tool-config';
import { getDefaultChatTools } from '@/lib/chat/tool-prefs';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { codeProjectAccess, codeProjectAccessMessage } from '@/lib/code/access';
import { DEFAULT_CODE_INSTRUCTIONS } from '@/lib/code/default-instructions';
import { replaceProjectEnv } from '@/lib/code/projects';
import { recordAuditEvent } from '@/lib/audit-events';

const DOTENV_MAX_CHARS = 200_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const sidebar = await loadChatSidebar(db, tenantId, session.subject);
  return NextResponse.json({ projects: sidebar.code.projects });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!sandboxWorkspacesEnabled()) {
    return jsonError(503, 'unavailable', 'Code workspaces are not enabled on this deployment.');
  }
  const body = await readJsonBody(request);
  // The host this repository lives on — Bitbucket unless the form said
  // otherwise, so an older client that never sent `provider` keeps working.
  const provider =
    typeof body.provider === 'string' && body.provider === GITHUB ? GITHUB : ATLASSIAN_BITBUCKET;
  // The same bar the Code page shows: a connection on that host that can
  // clone, push and open pull requests, or no project.
  const access = await codeProjectAccess(db, tenantId, session.subject, provider);
  if (!access.ok) {
    return jsonError(
      403,
      provider === GITHUB ? 'github' : 'bitbucket',
      codeProjectAccessMessage(access, provider) ??
        `Connect ${provider === GITHUB ? 'GitHub' : 'Bitbucket'} first.`
    );
  }
  const repo = validateRepoFullName(body.repository);
  if (!repo.ok) return jsonError(400, 'invalid', repo.message);
  // The repository names the project unless the person renamed it; the
  // slug alone (not `workspace/repo`) reads like a project name.
  const name =
    optionalString(body.name, PROJECT_NAME_MAX_CHARS) ||
    repo.fullName.split('/').pop() ||
    repo.fullName;
  let branch = '';
  if (typeof body.branch === 'string' && body.branch.trim()) {
    const ref = validateGitRef(body.branch);
    if (!ref.ok) return jsonError(400, 'invalid', ref.message);
    branch = ref.ref;
  }
  const description = optionalString(body.description, 2_000) ?? null;
  // Instructions left out of the request get the standing developer's
  // brief; instructions sent blank were cleared on purpose and stay so.
  const instructions =
    body.instructions === undefined
      ? DEFAULT_CODE_INSTRUCTIONS
      : (optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS) ?? null);
  // The toolset the project's chats start with: what the form chose, else
  // the person's own default for code projects, else the code default —
  // copied onto the project now (tool-config.ts), so a later change to the
  // preference leaves this project as it was made. The git host connectors
  // ride along whatever was chosen; both are locked on in every code chat
  // anyway (CODE_PROJECT_CONNECTORS).
  const chosen = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const toolConfig = withRequiredConnectors(
    chosen ??
      (await getDefaultChatTools(tenantId, session.subject, { fresh: true, kind: 'code' })) ??
      defaultToolConfig('code'),
    CODE_PROJECT_CONNECTORS
  );
  const dotenv = typeof body.env === 'string' ? body.env : '';
  if (dotenv.length > DOTENV_MAX_CHARS) return jsonError(413, 'invalid', 'The .env is too large.');

  const projectId = await createProject(db, {
    tenantId,
    ownerSubject: session.subject,
    name,
    description: description || null,
    instructions: instructions || null,
    toolConfig,
    repo: { provider, fullName: repo.fullName, branch },
  });
  if (!projectId)
    return jsonError(500, 'content-key', 'The content encryption key is not configured.');
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project) return jsonError(500, 'internal', 'The project could not be read back.');

  const problems: string[] = [];
  if (dotenv.trim()) {
    const env = await replaceProjectEnv(project, dotenv);
    if (!env.ok) return jsonError(env.status, 'env', env.message);
    problems.push(...env.val.problems);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.project.created',
    targetKind: 'code_project',
    targetLabel: name,
    details: { projectId, repository: repo.fullName, branch: branch || null },
  });
  return NextResponse.json({ projectId, envProblems: problems }, { status: 201 });
}
