/**
 * What the thread draws inline for a file it cannot lay out from the raw
 * bytes in the browser: the corner of a workbook's first sheet (or a
 * CSV), or — for a legacy Office file — the text extracted at upload. Same access
 * as the download (whoever may read the chat or project); JSON only, so
 * nothing here is ever rendered as markup.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getAttachment, getAttachmentText } from '@/lib/chat/attachments';
import { attachmentCipherFor } from '@/lib/chat/attachment-access';
import { extensionOf, previewKind } from '@/lib/chat/preview-kind';
import { sheetFromCsv, sheetFromXlsx } from '@/lib/chat/sheet-preview';

export const runtime = 'nodejs';

/** Enough of a long text to see what it is; the download has the rest. */
const MAX_TEXT_CHARS = 20_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; attachmentId: string }> }
): Promise<Response> {
  const { tenantId, attachmentId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const row = await getAttachment(db, tenantId, attachmentId);
  const cipher = row ? await attachmentCipherFor(db, tenantId, session.subject, row) : null;
  if (!row || !cipher) {
    return jsonError(404, 'not-found', 'No such file');
  }
  const headers = { 'Cache-Control': 'private, no-store' };
  const kind = previewKind(row);

  if (kind === 'sheet') {
    const store = await resolveTenantBlobStore(tenantId);
    if (!store.ok) return jsonError(503, 'uploads-off', 'The file store is not configured.');
    const object = await store.val.getObject(row.blobKey);
    if (!object.ok) return jsonError(502, 'store', 'The file is unavailable.');
    const csv = row.contentType === 'text/csv' || extensionOf(row.filename) === 'csv';
    try {
      const sheet = csv
        ? sheetFromCsv(new TextDecoder().decode(object.val.bytes), row.filename)
        : await sheetFromXlsx(object.val.bytes);
      if (!sheet) return jsonError(422, 'empty', 'The workbook has no sheets.');
      return NextResponse.json({ kind: 'sheet', sheet }, { headers });
    } catch {
      return jsonError(422, 'unreadable', 'The workbook could not be read.');
    }
  }

  if (kind === 'extract') {
    const text = await getAttachmentText(db, tenantId, row.id, cipher);
    if (text === null) return jsonError(422, 'no-text', 'No text was extracted from this file.');
    return NextResponse.json(
      {
        kind: 'extract',
        text: text.slice(0, MAX_TEXT_CHARS),
        truncated: text.length > MAX_TEXT_CHARS,
      },
      { headers }
    );
  }

  return jsonError(415, 'no-preview', 'This file is shown from its own bytes, or not at all.');
}
