/**
 * The text a file holds, as a download: the OCR read of a scan or a PDF, or
 * the text the file already had. The same people can have it as can have the
 * file itself, and it is opened under the same access (artifact-access.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getAttachmentText } from '@/lib/chat/attachments';
import { resolveArtifactAccess } from '@/lib/chat/artifact-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ attachmentId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { attachmentId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!isUuid(attachmentId)) return jsonError(404, 'not-found', 'No such file');
  const access = await resolveArtifactAccess(db, session.subject, attachmentId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  const text = await getAttachmentText(db, access.row.id, access.cipher);
  if (text === null) return jsonError(404, 'not-found', 'This file has no text');
  const base = access.row.filename.replace(/\.[^.]+$/, '') || 'file';
  const encodedName = encodeURIComponent(`${base}.txt`).replace(/'/g, '%27');
  return new NextResponse(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
