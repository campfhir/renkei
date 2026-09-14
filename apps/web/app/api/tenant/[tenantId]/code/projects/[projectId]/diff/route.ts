/**
 * The project's uncommitted changes: the working tree against HEAD as a
 * unified diff (untracked files included), per-file line counts, and
 * the branch. Any member may look. `context` is the lines around each
 * hunk (the page offers a few settings); `path` narrows to one file.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { DIFF_DEFAULT_CONTEXT, DIFF_MAX_CONTEXT } from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbWorkspaceGitDiff,
} from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { codeProjectTarget } from '@/lib/code/scope';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return jsonError(404, 'not-found', 'No such project');
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code') return jsonError(404, 'not-found', 'No such project');
  if (!sandboxWorkspacesEnabled() || !project.workspaceId) {
    return NextResponse.json({
      branch: project.repo?.branch ?? '',
      diff: '',
      files: [],
      truncated: false,
      available: false,
    });
  }
  const url = new URL(request.url);
  const contextRaw = Number(url.searchParams.get('context') ?? DIFF_DEFAULT_CONTEXT);
  const context = Number.isFinite(contextRaw)
    ? Math.min(DIFF_MAX_CONTEXT, Math.max(0, Math.floor(contextRaw)))
    : DIFF_DEFAULT_CONTEXT;
  const path = url.searchParams.get('path');
  const result = await sbWorkspaceGitDiff(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    context,
    ...(path ? { paths: [path] } : {}),
  });
  if (!result.ok) {
    // A checkout still cloning, failed or gone answers "nothing to show"
    // rather than an error: the page's Changes button is best-effort.
    const failure = clientFailure(result.err);
    if (failure.status === 404 || failure.status === 409) {
      return NextResponse.json({
        branch: project.repo?.branch ?? '',
        diff: '',
        files: [],
        truncated: false,
        available: false,
      });
    }
    return jsonError(failure.status, 'diff', failure.message);
  }
  return NextResponse.json({ ...result.val, available: true });
}
