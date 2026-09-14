/**
 * A file added to the project's checkout by a person (editors): the
 * body is the file, `path` in the query string says where in the
 * repository it lands. A code project keeps no files of its own — what
 * a chat should see belongs in the repository, where a chat can commit
 * it — so this is the one way a person's file reaches the project. The
 * bytes are written as they are, uncommitted, by the sandbox worker.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { UPLOAD_MAX_BYTES, validateWorkspacePath } from '@renkei/connector-sandbox';
import { clientFailure, sandboxWorkspacesEnabled, sbWorkspaceUpload } from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!sandboxWorkspacesEnabled()) {
    return jsonError(503, 'unavailable', 'Code workspaces are not enabled on this deployment.');
  }
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) return jsonError(404, 'not-found', 'No such project');
  if (access.role === 'viewer')
    return jsonError(403, 'read-only', 'Only editors can add files to this project’s repository.');
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code') return jsonError(404, 'not-found', 'No such project');
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'Clone the repository before adding files to it.');

  const path = validateWorkspacePath(new URL(request.url).searchParams.get('path'), {
    forWrite: true,
  });
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say where the file goes.' : path.message);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > UPLOAD_MAX_BYTES) return jsonError(413, 'too-large', tooLarge());
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return jsonError(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return jsonError(413, 'too-large', tooLarge());

  const written = await sbWorkspaceUpload(codeProjectTarget(tenantId, projectId), {
    id: project.workspaceId,
    path: path.path,
    bytes,
  });
  if (!written.ok) {
    const failure = clientFailure(written.err);
    return jsonError(failure.status, 'upload', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.files.uploaded',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, path: written.val.path, sizeBytes: written.val.sizeBytes },
  });
  return NextResponse.json({ file: written.val });
}

function tooLarge(): string {
  return `Files are limited to ${Math.round(UPLOAD_MAX_BYTES / 1_048_576)} MB.`;
}
