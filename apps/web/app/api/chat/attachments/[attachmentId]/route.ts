/**
 * Download and delete. A download streams through the app under the
 * caller's session — to whoever may read the artifact (artifact-access.ts:
 * its owner, a person it is shared with, a member of a project holding
 * it, a reader of its chat) — as an attachment with the content type
 * forced to something a browser will not execute, unless it is an image,
 * a PDF or plain text it can safely show. Delete is the owner's and
 * removes the file for everyone; a project editor deleting someone
 * else's file detaches it from the project instead (`?projectId=`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getAttachment } from '@/lib/chat/attachments';
import { mayReadAttachment, resolveArtifactAccess } from '@/lib/chat/artifact-access';
import { deleteArtifact, detachFromProject } from '@/lib/chat/artifact-library';

export const runtime = 'nodejs';

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
  const { attachmentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await getAttachment(db, attachmentId);
  if (!row || !(await mayReadAttachment(db, session.subject, row))) {
    return jsonError(404, 'not-found', 'No such file');
  }
  const store = await resolveTenantBlobStore();
  if (!store.ok) return jsonError(503, 'uploads-off', 'The file store is not configured.');
  const object = await store.val.getObjectStream(row.blobKey);
  if (!object.ok) {
    return jsonError(
      object.err.type === 'NOT_FOUND' ? 404 : 502,
      'store',
      'The file is unavailable.'
    );
  }
  const inline = SAFE_INLINE.test(row.contentType);
  const encodedName = encodeURIComponent(row.filename).replace(/'/g, '%27');
  return new Response(object.val.body, {
    headers: {
      'Content-Type': inline ? row.contentType : 'application/octet-stream',
      ...(object.val.contentLength !== null
        ? { 'Content-Length': String(object.val.contentLength) }
        : {}),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
  const { attachmentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const projectId = new URL(request.url).searchParams.get('projectId');
  const access = await resolveArtifactAccess(
    db,
    session.subject,
    attachmentId,
    projectId && isUuid(projectId) ? projectId : null
  );
  if (!access) return jsonError(404, 'not-found', 'No such file');
  if (access.role === 'owner' && !projectId) {
    await deleteArtifact(db, access.row);
    return NextResponse.json({ ok: true, detached: false });
  }
  const target = projectId && isUuid(projectId) ? projectId : access.projectId;
  if (!target) return jsonError(404, 'not-found', 'No such file');
  const detached = await detachFromProject(db, {
    actorSubject: session.subject,
    artifactId: access.row.id,
    projectId: target,
  });
  if (!detached.ok) {
    return detached.err.type === 'FORBIDDEN'
      ? jsonError(403, 'read-only', 'Only the project’s owner and editors can remove its files.')
      : jsonError(404, 'not-found', 'No such file');
  }
  return NextResponse.json({ ok: true, detached: true });
}
