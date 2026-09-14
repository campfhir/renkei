/**
 * Code projects: the ones this person can open, and creation. Creating
 * one is a chat project with a repository on it: the row is written,
 * the `.env` (if pasted) goes to the sandbox worker under the project's
 * scope, and a clone is started with the person's own Bitbucket grant —
 * the page then polls until the checkout reads ready.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateGitRef, validateRepoFullName } from '@renkei/connector-sandbox';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
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
import { parseToolConfig } from '@/lib/chat/tool-config';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { replaceProjectEnv, startProjectClone } from '@/lib/code/projects';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { getOrigin } from '@/lib/get-origin';
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
  const name = optionalString(body.name, PROJECT_NAME_MAX_CHARS);
  if (!name) return jsonError(400, 'invalid', 'Give the project a name');
  const repo = validateRepoFullName(body.repository);
  if (!repo.ok) return jsonError(400, 'invalid', repo.message);
  let branch = '';
  if (typeof body.branch === 'string' && body.branch.trim()) {
    const ref = validateGitRef(body.branch);
    if (!ref.ok) return jsonError(400, 'invalid', ref.message);
    branch = ref.ref;
  }
  const description = optionalString(body.description, 2_000) ?? null;
  const instructions = optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS) ?? null;
  const toolConfig = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const dotenv = typeof body.env === 'string' ? body.env : '';
  if (dotenv.length > DOTENV_MAX_CHARS) return jsonError(413, 'invalid', 'The .env is too large.');

  // The credential first: a project whose repository cannot be reached is
  // not worth a row.
  const origin = await getOrigin(request);
  const credential = await resolveWorkspaceGitCredential(
    { tenantId, subject: session.subject, origin: origin.ok ? origin.val : '' },
    { write: false }
  );
  if (typeof credential === 'string') return jsonError(409, 'bitbucket', credential);

  const projectId = await createProject(db, {
    tenantId,
    ownerSubject: session.subject,
    name,
    description: description || null,
    instructions: instructions || null,
    toolConfig,
    repo: { provider: 'atlassian-bitbucket', fullName: repo.fullName, branch },
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
  const clone = await startProjectClone(db, project, credential);
  if (!clone.ok) return jsonError(clone.status, 'clone', clone.message);

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
