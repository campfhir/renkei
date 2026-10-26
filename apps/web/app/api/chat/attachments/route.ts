/**
 * Upload: raw bytes in the body (the files browser's idiom — no multipart),
 * the destination and name in the query. Refused before a byte is read
 * when Content-Length exceeds the org's attachment cap, and again after,
 * since a length header is a claim.
 *
 * Where it lands (docs/artifacts-design.md):
 *   - `chatId`: the chat's own file, sealed under the chat's key — the
 *     owner's draft, sent with the next message. With `keep=1` it is also
 *     made the person's artifact (a key of its own) and, with `projectId`,
 *     attached to that project as well.
 *   - `projectId` alone: an artifact of the uploader's, attached to the
 *     project — anyone who may edit it. `mode` says how its chats use it.
 *   - neither: an artifact in the uploader's library, attached nowhere yet.
 */

import type { NextRequest } from 'next/server';
import { NextResponse, after } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess, resolveProjectAccess } from '@/lib/chat/access';
import {
  createAttachment,
  isReferenceMode,
  toAttachmentView,
  type AttachmentError,
  type ReferenceMode,
} from '@/lib/chat/attachments';
import { attachToProject, createOwnedArtifact } from '@/lib/chat/artifact-library';
import { deferDigest } from '@/lib/chat/artifact-digest';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';
import { routeLog } from '@/lib/log-context';

export const runtime = 'nodejs';

function uploadError(error: AttachmentError): Response {
  switch (error) {
    case 'TOO_LARGE':
      return jsonError(413, 'too-large', 'The file is too large.');
    case 'UNCONFIGURED':
      return jsonError(503, 'uploads-off', 'File uploads are not configured.');
    case 'CONTENT_KEY':
      return jsonError(500, 'content-key', 'The content encryption key is not available.');
    case 'STORE':
      return jsonError(502, 'store', 'The file store refused the upload.');
    default:
      return jsonError(500, 'database', 'The file could not be saved.');
  }
}

async function PUTHandler(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!(await tenantBlobStoreConfigured())) {
    return jsonError(
      503,
      'uploads-off',
      'File storage is not set up for this organization. An operator can add it under Organization → Storage.'
    );
  }

  const url = new URL(request.url);
  const chatId = url.searchParams.get('chatId');
  const projectId = url.searchParams.get('projectId');
  const keep = url.searchParams.get('keep') === '1';
  const filename = url.searchParams.get('filename') ?? 'file';
  const contentType = url.searchParams.get('contentType') ?? request.headers.get('content-type');
  const modeParam = url.searchParams.get('mode');
  const mode: ReferenceMode = isReferenceMode(modeParam) ? modeParam : 'on_demand';

  const chat = chatId
    ? isUuid(chatId)
      ? await resolveChatAccess(db, session.subject, chatId)
      : null
    : null;
  if (chatId && (!chat || chat.role !== 'owner'))
    return jsonError(404, 'not-found', 'No such chat');
  if (projectId) {
    if (!isUuid(projectId)) return jsonError(404, 'not-found', 'No such project');
    const access = await resolveProjectAccess(db, session.subject, projectId);
    if (!access) return jsonError(404, 'not-found', 'No such project');
    if (access.role === 'viewer') {
      return jsonError(403, 'read-only', 'Only editors can add files to this project.');
    }
  }

  const settingsResult = await getOrgSettings();
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
  // A body cut short on its way in is not the file the person sent; keep
  // nothing rather than a truncated copy.
  if (declared > 0 && bytes.byteLength !== declared) {
    return jsonError(400, 'incomplete', 'The upload was cut short. Try again.');
  }
  if (bytes.byteLength > maxBytes) {
    return jsonError(
      413,
      'too-large',
      `Files are limited to ${Math.round(maxBytes / 1_048_576)} MB.`
    );
  }
  const redactor = settings ? createOutboundRedactor(settings) : null;

  // A plain chat upload stays under the chat's key, as before.
  if (chat && !keep && !projectId) {
    const created = await createAttachment(db, {
      ownerSubject: session.subject,
      chatId: chat.chat.id,
      filename,
      contentType: contentType ?? 'application/octet-stream',
      bytes,
      maxBytes,
      redactor,
      cipher: chat.cipher,
      key: { kind: 'chat', ref: chat.chat.id },
    });
    if (!created.ok) return uploadError(created.err.type);
    deferDigest(db, session.subject, [created.val], after);
    return NextResponse.json({ attachment: toAttachmentView(created.val) }, { status: 201 });
  }

  const created = await createOwnedArtifact(db, {
    ownerSubject: session.subject,
    chatId: chat?.chat.id ?? null,
    filename,
    contentType: contentType ?? 'application/octet-stream',
    bytes,
    maxBytes,
    redactor,
  });
  if (!created.ok) return uploadError(created.err.type);
  // The summary and keywords for the search index, asked for after the reply.
  deferDigest(db, session.subject, [created.val], after);
  let attached: { mode: ReferenceMode } | null = null;
  if (projectId) {
    const result = await attachToProject(db, {
      actorSubject: session.subject,
      artifactId: created.val.id,
      projectId,
      mode,
    });
    // Over the budget, it still lands — on demand.
    attached = result.ok
      ? { mode: result.val.mode }
      : result.err.type === 'BUDGET' || result.err.type === 'INVALID'
        ? (
            await attachToProject(db, {
              actorSubject: session.subject,
              artifactId: created.val.id,
              projectId,
              mode: 'on_demand',
            })
          ).ok
          ? { mode: 'on_demand' }
          : null
        : null;
  }
  return NextResponse.json(
    { attachment: toAttachmentView(created.val), attached },
    { status: 201 }
  );
}

export const PUT = routeLog(PUTHandler);
