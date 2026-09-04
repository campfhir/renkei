/**
 * Upload: raw bytes in the body (the files browser's idiom — no multipart),
 * the destination and name in the query. Refused before a byte is read
 * when Content-Length exceeds the org's attachment cap, and again after,
 * since a length header is a claim. Into a chat: the owner's. Into a
 * project: anyone who may edit it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getChatForOwner } from '@/lib/chat/store';
import { createAttachment, toAttachmentView } from '@/lib/chat/attachments';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';

export const runtime = 'nodejs';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!(await tenantBlobStoreConfigured(tenantId))) {
    return jsonError(
      503,
      'uploads-off',
      'File storage is not set up for this organization. An operator can add it under Organization → Storage.'
    );
  }

  const url = new URL(request.url);
  const chatId = url.searchParams.get('chatId');
  const projectId = url.searchParams.get('projectId');
  const filename = url.searchParams.get('filename') ?? 'file';
  const contentType = url.searchParams.get('contentType') ?? request.headers.get('content-type');

  if (chatId) {
    if (!isUuid(chatId) || !(await getChatForOwner(db, tenantId, session.subject, chatId))) {
      return jsonError(404, 'not-found', 'No such chat');
    }
  } else if (projectId) {
    if (!isUuid(projectId)) return jsonError(404, 'not-found', 'No such project');
    const access = await resolveResourceAccess(
      db,
      tenantId,
      session.subject,
      'chat_project',
      projectId
    );
    if (!access) return jsonError(404, 'not-found', 'No such project');
    if (access.role === 'viewer') {
      return jsonError(403, 'read-only', 'Only editors can add files to this project.');
    }
  } else {
    return jsonError(400, 'invalid', 'Say which chat or project the file belongs to.');
  }

  const settingsResult = await getOrgSettings(tenantId);
  const settings = settingsResult.ok ? settingsResult.val : null;
  const maxBytes = settings?.maxAttachmentBytes ?? 20_971_520;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    return jsonError(
      413,
      'too-large',
      `Files are limited to ${Math.round(maxBytes / 1_048_576)} MB.`
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return jsonError(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > maxBytes) {
    return jsonError(
      413,
      'too-large',
      `Files are limited to ${Math.round(maxBytes / 1_048_576)} MB.`
    );
  }

  const created = await createAttachment(db, {
    tenantId,
    ownerSubject: session.subject,
    chatId: chatId ?? null,
    projectId: chatId ? null : projectId,
    filename,
    contentType: contentType ?? 'application/octet-stream',
    bytes,
    maxBytes,
    redactor: settings ? createOutboundRedactor(tenantId, settings) : null,
  });
  if (!created.ok) {
    switch (created.err.type) {
      case 'TOO_LARGE':
        return jsonError(413, 'too-large', 'The file is too large.');
      case 'UNCONFIGURED':
        return jsonError(503, 'uploads-off', 'File uploads are not configured.');
      case 'CONTENT_KEY':
        return jsonError(500, 'content-key', 'The content encryption key is not configured.');
      case 'STORE':
        return jsonError(502, 'store', 'The file store refused the upload.');
      default:
        return jsonError(500, 'database', 'The file could not be saved.');
    }
  }
  return NextResponse.json({ attachment: toAttachmentView(created.val) }, { status: 201 });
}
