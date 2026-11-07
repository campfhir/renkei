/**
 * A checkout's own history, from the sandbox worker rather than the code
 * host: the commits of the current branch (or `?ref=` a revision or a
 * range such as `origin/main..HEAD`, `?path=` for one file's history,
 * `?max=` and `?skip=` to page), as `code_git_log` answers them in a
 * chat — including commits made here and not yet pushed, which
 * commits/route.ts (the host's view) cannot see. Through
 * `/chats/[chatId]/log` it is the chat's worktree.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientFailure, sbWorkspaceGitLog } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const { session, workspaceId } = ready.context;
  if (!workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to read history from yet.');
  const query = request.nextUrl.searchParams;
  const max = Number(query.get('max') ?? '');
  const skip = Number(query.get('skip') ?? '');
  const path = query.get('path') ?? '';
  const logged = await sbWorkspaceGitLog(codeProjectTarget(projectId), {
    id: workspaceId,
    ...(query.get('ref') ? { ref: query.get('ref')! } : {}),
    ...(path ? { paths: [path] } : {}),
    ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    ...(Number.isFinite(skip) && skip > 0 ? { skip } : {}),
  });
  if (!logged.ok) {
    const failure = clientFailure(logged.err);
    if (failure.status !== 400 && failure.status !== 404 && failure.status !== 409) {
      logger[failure.status >= 500 ? 'error' : 'warn'](
        'Sandbox request failed ({status}): {error}',
        {
          component: 'api/code/projects/log',
          subject: session.subject,
          projectId,
          chatId,
          operation: 'log',
          status: failure.status,
          error:
            'message' in logged.err && logged.err.message ? logged.err.message : failure.message,
        }
      );
    }
    return jsonError(failure.status, 'log', failure.message);
  }
  return NextResponse.json(logged.val);
}
