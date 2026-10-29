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
import {
  chatRequestContext,
  jsonError,
  readBytesError,
  readJsonBody,
} from '@/lib/chat/route-support';
import { readAttachmentBytes } from '@/lib/chat/attachments';
import { resolveArtifactAccess } from '@/lib/chat/artifact-access';
import { executeUpload } from '@/lib/upload-executors';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
  const { attachmentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const access = await resolveArtifactAccess(session.subject, attachmentId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  const { row } = access;

  const body = await readJsonBody(request);
  if (body.kind !== 'fileshare-file') {
    return jsonError(400, 'invalid', 'Only file shares can be copied to for now.');
  }
  const shareId = typeof body.shareId === 'string' ? body.shareId : '';
  const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : '/';
  if (!shareId) return jsonError(400, 'invalid', 'Choose a share.');

  const object = await readAttachmentBytes(row, access.cipher);
  if (!object.ok) return readBytesError(object.err.type);

  const outcome = await executeUpload(
    {
      id: randomUUID(),
      subject: session.subject,
      account_id: '',
      kind: 'fileshare-file',
      destination: { shareId, path },
      filename: row.filename,
      content_type: row.contentType,
    },
    Buffer.from(object.val)
  );
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
}
