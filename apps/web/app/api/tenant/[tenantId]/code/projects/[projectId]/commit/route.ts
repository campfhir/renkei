/**
 * A commit made by a person from the code pane: whatever is in the
 * working tree — theirs and the chat's — or only the listed paths,
 * recorded on the checkout's branch or on a new one first, authored as
 * them, exactly as the chat's `code_git_commit` tool does it. Nothing
 * leaves the sandbox: a push is its own route. Editors only; refused in
 * org read-only mode. The pane writes the transcript's note afterwards
 * (`…/chat/chats/[chatId]/notes`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  COMMIT_MESSAGE_MAX_CHARS,
  validateGitRef,
  validateWorkspacePath,
} from '@renkei/connector-sandbox';
import { clientFailure, sbWorkspaceGitCommit } from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { getOrigin } from '@/lib/get-origin';
import { getIdentityDisplay } from '@/lib/identity';
import { commitAuthorFor, resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { recordAuditEvent } from '@/lib/audit-events';

const MAX_PATHS = 200;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to commit in yet.');

  const body = await readJsonBody(request);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return jsonError(400, 'invalid', 'Write a commit message.');
  if (message.length > COMMIT_MESSAGE_MAX_CHARS)
    return jsonError(
      400,
      'invalid',
      `A commit message is at most ${COMMIT_MESSAGE_MAX_CHARS} characters.`
    );
  const paths: string[] = [];
  if (Array.isArray(body.paths)) {
    if (body.paths.length > MAX_PATHS)
      return jsonError(400, 'invalid', `At most ${MAX_PATHS} paths in one commit.`);
    for (const raw of body.paths) {
      const path = validateWorkspacePath(raw, { forWrite: true });
      if (!path.ok || !path.path)
        return jsonError(400, 'invalid', path.ok ? 'An empty path.' : path.message);
      paths.push(path.path);
    }
  }
  let newBranch: string | undefined;
  if (typeof body.newBranch === 'string' && body.newBranch.trim()) {
    const ref = validateGitRef(body.newBranch);
    if (!ref.ok) return jsonError(400, 'invalid', ref.message);
    newBranch = ref.ref;
  }

  const origin = await getOrigin(request);
  const [credential, person] = await Promise.all([
    resolveWorkspaceGitCredential(
      {
        tenantId,
        subject: session.subject,
        origin: origin.ok ? origin.val : '',
        provider: project.repo!.provider,
      },
      { write: false }
    ),
    getIdentityDisplay(tenantId, session.subject),
  ]);
  const username = typeof credential === 'string' ? '' : credential.username;
  const committed = await sbWorkspaceGitCommit(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    message,
    ...(paths.length ? { paths } : {}),
    ...(newBranch ? { newBranch } : {}),
    author: commitAuthorFor(
      person?.displayName || username || session.subject,
      person?.email ?? undefined,
      project.repo!.provider
    ),
  });
  if (!committed.ok) {
    const failure = clientFailure(committed.err);
    return jsonError(failure.status, 'commit', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.commit',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: {
      projectId,
      branch: committed.val.branch,
      commit: committed.val.commit,
      paths: paths.length,
    },
  });
  return NextResponse.json({
    branch: committed.val.branch,
    sha: committed.val.commit,
    subject: message.split('\n')[0] ?? message,
  });
}
