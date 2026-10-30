/**
 * A copy of the checkout to keep: `?path=` names a file, which comes as
 * its own bytes, or a folder — or nothing, the whole checkout — which
 * comes as a zip, made on the sandbox worker and streamed here as it is
 * made. The zip is the folder as it is on disk, so ignored files
 * (node_modules, build output) are in it — the point of an offline copy
 * — and `.git` is not; the repository's history is on its host. Under
 * `/chats/[chatId]/` it is that chat's worktree; at the project's own
 * address, the project's base clone. Any member may download; before a
 * clone there is no checkout to copy (409).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateWorkspacePath } from '@renkei/connector-sandbox';
import { clientFailure, sbWorkspaceDownload } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { projectWorkspace } from '@/lib/code/projects';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';
import { downloadName } from '@/lib/code/download-name';
import { logger } from '@/lib/logger';

/** The name in a Content-Disposition header, ASCII-safe with the real one beside it. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId } = ready.context;
  const path = validateWorkspacePath(new URL(request.url).searchParams.get('path'));
  if (!path.ok) return jsonError(400, 'invalid', path.message);
  if (!workspaceId) return jsonError(409, 'not-cloned', 'There is no checkout to download yet.');
  const workspace = await projectWorkspace(project, workspaceId);
  if (workspace?.status !== 'ready') {
    return jsonError(409, 'not-cloned', 'There is no checkout to download yet.');
  }

  const got = await sbWorkspaceDownload(codeProjectTarget(projectId), {
    id: workspaceId,
    path: path.path,
  });
  if (!got.ok) {
    const failure = clientFailure(got.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn']('Sandbox request failed ({status}): {error}', {
        component: 'api/code/projects/archive',
        subject: session.subject,
        projectId,
        chatId,
        operation: 'download',
        status: failure.status,
        error: 'message' in got.err && got.err.message ? got.err.message : failure.message,
      });
    }
    return jsonError(failure.status, 'download', failure.message);
  }
  const name = downloadName(path.path, project.repo!.fullName, got.val.kind);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.files.downloaded',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, chatId: chatId ?? null, path: path.path || '.', kind: got.val.kind },
  });
  const headers = new Headers({
    'content-type': got.val.contentType,
    'content-disposition': contentDisposition(name),
    'cache-control': 'no-store',
    'x-download-kind': got.val.kind,
  });
  if (got.val.sizeBytes !== null) headers.set('content-length', String(got.val.sizeBytes));
  return new NextResponse(got.val.body, { status: 200, headers });
}
