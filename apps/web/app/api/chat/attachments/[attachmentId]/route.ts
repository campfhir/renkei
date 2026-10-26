/**
 * Download and delete. A download goes through the app under the
 * caller's session — to whoever may read the artifact (artifact-access.ts:
 * its owner, a person it is shared with, a member of a project holding
 * it, a reader of its chat), opened under the key their access resolves,
 * since the store holds the bytes sealed — as an attachment with the
 * content type forced to something a browser will not execute, unless it
 * is an image, a PDF or plain text it can safely show. Delete is the
 * owner's and removes the file for everyone; a project editor deleting
 * someone else's file detaches it from the project instead
 * (`?projectId=`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError, readBytesError } from '@/lib/chat/route-support';
import { readAttachmentBytes } from '@/lib/chat/attachments';
import { resolveArtifactAccess } from '@/lib/chat/artifact-access';
import { deleteArtifact, detachFromProject } from '@/lib/chat/artifact-library';
import { routeLog } from '@/lib/log-context';

export const runtime = 'nodejs';

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
  const { attachmentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, attachmentId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  const { row } = access;
  const object = await readAttachmentBytes(row, access.cipher);
  if (!object.ok) return readBytesError(object.err.type);
  const inline = SAFE_INLINE.test(row.contentType);
  const encodedName = encodeURIComponent(row.filename).replace(/'/g, '%27');
  return new Response(Buffer.from(object.val), {
    headers: {
      'Content-Type': inline ? row.contentType : 'application/octet-stream',
      'Content-Length': String(object.val.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

async function DELETEHandler(
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

export const GET = routeLog(GETHandler);
export const DELETE = routeLog(DELETEHandler);
