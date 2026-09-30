/**
 * OCR for a chat's unsent attachments that came up as needs_ocr (scans and
 * images). The composer calls this after a mass upload, in batches, and
 * again for whatever is still pending. Only the owner's files in their own
 * chat are touched.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { isUuid } from '@/lib/uuid';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { getChatForOwner } from '@/lib/chat/store';
import { ocrChatAttachments } from '@/lib/chat/attachments';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';

export const runtime = 'nodejs';

/** One request OCRs at most this many files; the client sends the rest in the next. */
const MAX_IDS_PER_REQUEST = 12;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;

  const body: unknown = await request.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? body : {};
  const chatId = 'chatId' in record && typeof record.chatId === 'string' ? record.chatId : '';
  const ids =
    'attachmentIds' in record && Array.isArray(record.attachmentIds)
      ? record.attachmentIds
          .filter((id): id is string => typeof id === 'string')
          .slice(0, MAX_IDS_PER_REQUEST)
      : [];
  if (!isUuid(chatId) || !(await getChatForOwner(db, tenantId, session.subject, chatId))) {
    return jsonError(404, 'not-found', 'No such chat');
  }

  const settings = await getOrgSettings(tenantId);
  const results = await ocrChatAttachments(db, {
    tenantId,
    ownerSubject: session.subject,
    chatId,
    attachmentIds: ids,
    redactor: settings.ok ? createOutboundRedactor(tenantId, settings.val) : null,
  });
  return NextResponse.json({ results });
}
