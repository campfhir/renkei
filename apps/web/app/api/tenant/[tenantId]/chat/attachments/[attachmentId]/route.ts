/**
 * Download and delete. A download streams through the app under the
 * caller's session — chat files to whoever may read the chat, project
 * files to whoever may open the project — as an attachment with the
 * content type forced to something a browser will not execute, unless it
 * is an image, a PDF or plain text it can safely show. Delete is the
 * uploader's, or a project editor's for project files.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getBlobStore } from '@renkei/blob-store';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess, resolveResourceAccess } from '@/lib/chat/access';
import { deleteAttachment, getAttachment, type AttachmentRow } from '@/lib/chat/attachments';

export const runtime = 'nodejs';

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

async function mayRead(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  row: AttachmentRow
): Promise<boolean> {
  if (row.chatId) return (await resolveChatAccess(db, tenantId, subject, row.chatId)) !== null;
  if (row.projectId) {
    return (
      (await resolveResourceAccess(db, tenantId, subject, 'chat_project', row.projectId)) !== null
    );
  }
  return false;
}

async function mayDelete(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  row: AttachmentRow
): Promise<boolean> {
  if (row.ownerSubject === subject) return true;
  if (row.projectId) {
    const access = await resolveResourceAccess(
      db,
      tenantId,
      subject,
      'chat_project',
      row.projectId
    );
    return access !== null && access.role !== 'viewer';
  }
  return false;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; attachmentId: string }> }
): Promise<Response> {
  const { tenantId, attachmentId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await getAttachment(db, tenantId, attachmentId);
  if (!row || !(await mayRead(db, tenantId, session.subject, row))) {
    return jsonError(404, 'not-found', 'No such file');
  }
  const store = getBlobStore();
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
  { params }: { params: Promise<{ tenantId: string; attachmentId: string }> }
): Promise<Response> {
  const { tenantId, attachmentId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await getAttachment(db, tenantId, attachmentId);
  if (!row || !(await mayDelete(db, tenantId, session.subject, row))) {
    return jsonError(404, 'not-found', 'No such file');
  }
  await deleteAttachment(db, tenantId, row);
  return NextResponse.json({ ok: true });
}
