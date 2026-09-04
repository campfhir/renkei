/**
 * Copy a chat file — an artifact the assistant produced, or an upload —
 * somewhere of the person's own: today a network file share they have
 * connected, through the same executor the upload slots use, so it is
 * written with their credentials. The working copy in the org's store is
 * untouched. Anyone who may read the file may copy it; the destination's
 * own permissions decide whether the write lands.
 */

import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getAttachment } from '@/lib/chat/attachments';
import { mayReadAttachment } from '@/lib/chat/attachment-access';
import { executeUpload } from '@/lib/upload-executors';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; attachmentId: string }> }
): Promise<Response> {
  const { tenantId, attachmentId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await getAttachment(db, tenantId, attachmentId);
  if (!row || !(await mayReadAttachment(db, tenantId, session.subject, row))) {
    return jsonError(404, 'not-found', 'No such file');
  }

  const body = await readJsonBody(request);
  if (body.kind !== 'fileshare-file') {
    return jsonError(400, 'invalid', 'Only file shares can be copied to for now.');
  }
  const shareId = typeof body.shareId === 'string' ? body.shareId : '';
  const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '/';
  if (!shareId) return jsonError(400, 'invalid', 'Choose a share.');

  const store = await resolveTenantBlobStore(tenantId);
  if (!store.ok) return jsonError(503, 'uploads-off', 'The file store is not configured.');
  const object = await store.val.getObject(row.blobKey);
  if (!object.ok) return jsonError(502, 'store', 'The file could not be read.');

  const outcome = await executeUpload(
    db,
    {
      id: randomUUID(),
      tenant_id: tenantId,
      subject: session.subject,
      account_id: '',
      kind: 'fileshare-file',
      destination: { shareId, path },
      filename: row.filename,
      content_type: row.contentType,
    },
    Buffer.from(object.val.bytes)
  );
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
}
