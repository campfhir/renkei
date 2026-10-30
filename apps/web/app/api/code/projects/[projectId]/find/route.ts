/**
 * Files of the project's repository whose path contains `q`, for the
 * composer's `@` completions — or, under `/chats/[chatId]/`, of that
 * chat's worktree. From the checkout on the sandbox once there is one
 * (the worker's `find`, a glob over every path, uncommitted additions
 * included — the same search the chat's own code_find tool runs);
 * before any chat has cloned, the repository's root directory from its
 * git host, filtered here, so the first level is there to complete
 * from without cloning anything. At most `MAX` paths, sorted, with
 * `truncated` when more matched. Any member may look.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientFailure, sandboxWorkspacesEnabled, sbWorkspaceFind } from '@renkei/sandbox-client';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError } from '@/lib/chat/route-support';
import { bitbucketAuthFor, listSource as listBitbucketSource } from '@/lib/code/bitbucket-browse';
import { githubAuthFor, listSource as listGitHubSource } from '@/lib/code/github-browse';
import { projectWorkspace } from '@/lib/code/projects';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { findGlob } from '@/lib/code/find-glob';
import { logger } from '@/lib/logger';

const MAX = 50;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId } = ready.context;
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim();

  const workspace =
    workspaceId && (await sandboxWorkspacesEnabled())
      ? await projectWorkspace(project, workspaceId)
      : null;
  if (workspace?.status === 'ready' && workspaceId) {
    const found = await sbWorkspaceFind(codeProjectTarget(projectId), {
      id: workspaceId,
      glob: findGlob(query),
      max: MAX,
    });
    if (!found.ok) {
      const failure = clientFailure(found.err);
      if (failure.status !== 400 && failure.status !== 404) {
        logger[failure.status >= 500 ? 'error' : 'warn']('Sandbox request failed ({status}): {error}', {
          component: 'api/code/projects/find',
          subject: session.subject,
          projectId,
          chatId,
          operation: 'find',
          status: failure.status,
          error: 'message' in found.err && found.err.message ? found.err.message : failure.message,
        });
      }
      return jsonError(failure.status, 'find', failure.message);
    }
    return NextResponse.json({
      paths: found.val.paths,
      truncated: found.val.truncated,
      source: 'checkout',
    });
  }

  const isGitHub = project.repo!.provider === GITHUB;
  const listed = isGitHub
    ? await listGitHubSource(
        await githubAuthFor(request, session.subject),
        project.repo!.fullName,
        project.repo!.branch,
        ''
      )
    : await listBitbucketSource(
        await bitbucketAuthFor(request, session.subject),
        project.repo!.fullName,
        project.repo!.branch,
        ''
      );
  if (!listed.ok) return jsonError(409, 'find', listed.error);
  const needle = query.toLowerCase();
  const paths = listed.entries
    .map((entry) => entry.path)
    .filter((path) => !needle || path.toLowerCase().includes(needle))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return NextResponse.json({
    paths: paths.slice(0, MAX),
    truncated: paths.length > MAX,
    source: isGitHub ? 'github' : 'bitbucket',
  });
}
