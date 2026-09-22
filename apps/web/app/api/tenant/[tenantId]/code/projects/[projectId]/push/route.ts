/**
 * A push made by a person from the code pane: the checkout's current
 * branch to origin, with their own grant on the project's git host
 * riding one worker call, exactly as the chat's `code_git_push` tool
 * does it. Never force-pushes. Editors only; refused in org read-only
 * mode.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateGitRef } from '@renkei/connector-sandbox';
import { clientFailure, sbWorkspaceGitPush } from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { getOrigin } from '@/lib/get-origin';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { recordAuditEvent } from '@/lib/audit-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to push yet.');

  const body = await readJsonBody(request);
  let branch: string | undefined;
  if (typeof body.branch === 'string' && body.branch.trim()) {
    const ref = validateGitRef(body.branch);
    if (!ref.ok) return jsonError(400, 'invalid', ref.message);
    branch = ref.ref;
  }
  const origin = await getOrigin(request);
  const credential = await resolveWorkspaceGitCredential(
    {
      tenantId,
      subject: session.subject,
      origin: origin.ok ? origin.val : '',
      provider: project.repo!.provider,
    },
    { write: true }
  );
  if (typeof credential === 'string') return jsonError(409, 'git-credential', credential);
  const pushed = await sbWorkspaceGitPush(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    authHeader: credential.authHeader,
    ...(branch ? { branch } : {}),
  });
  if (!pushed.ok) {
    const failure = clientFailure(pushed.err);
    return jsonError(failure.status, 'push', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.push',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, branch: pushed.val.branch, remoteBranch: pushed.val.remoteBranch },
  });
  return NextResponse.json(pushed.val);
}
