/**
 * The project's changes as a unified diff with per-file line counts and
 * the branch. Without `commit`: the working tree against HEAD, untracked
 * files included — what is not committed yet. With `commit=<hash>`: that
 * one commit against its parent, plus where it stands (`pushed` when a
 * remote branch holds it, `inHead` when the current branch's history
 * does) — how the Changes panel shows the commits a chat made. Any
 * member may look. `context` is the lines around each hunk (the page
 * offers a few settings); `path` narrows the working-tree diff to one
 * file; `stat=1` skips the text and answers counts and state.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { DIFF_DEFAULT_CONTEXT, DIFF_MAX_CONTEXT } from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbWorkspaceGitDiff,
  sbWorkspaceGitShow,
} from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { codeProjectTarget } from '@/lib/code/scope';

/** A commit is asked for by its hash, or a prefix of it — never a ref. */
const COMMIT_SHA = /^[0-9a-f]{4,40}$/i;

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
  const commit = url.searchParams.get('commit');
  const statOnly = url.searchParams.get('stat') === '1';
  const target = codeProjectTarget(tenantId, projectId);
  if (commit !== null) {
    if (!COMMIT_SHA.test(commit))
      return jsonError(400, 'invalid', 'A commit is named by its hash.');
    const shown = await sbWorkspaceGitShow(target, {
      id: project.workspaceId,
      commit,
      context,
      ...(statOnly ? { statOnly: true } : {}),
    });
    if (!shown.ok) {
      const failure = clientFailure(shown.err);
      if (failure.status === 404 || failure.status === 409) {
        // The checkout is not there, or no longer has the commit (cloned
        // again since): nothing to show, and the panel says so.
        return NextResponse.json({
          branch: project.repo?.branch ?? '',
          diff: '',
          files: [],
          truncated: false,
          available: false,
          commit: null,
        });
      }
      return jsonError(failure.status, 'diff', failure.message);
    }
    return NextResponse.json({ ...shown.val, available: true });
  }
  const result = await sbWorkspaceGitDiff(target, {
    id: project.workspaceId,
    context,
    ...(path ? { paths: [path] } : {}),
    ...(statOnly ? { statOnly: true } : {}),
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
