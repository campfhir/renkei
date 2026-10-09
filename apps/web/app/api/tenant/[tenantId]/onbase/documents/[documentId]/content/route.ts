/**
 * Raw document bytes out of OnBase, session-guarded — this URL is what
 * onbase_download_document hands to models, precisely because it
 * re-resolves the CALLER'S OWN OnBase grant at click time instead of
 * minting an anonymous link. The bytes move through the delegate and the
 * OnBase worker under that user's grant (the delegate attaches the token,
 * refreshes it when due and retries once on a 401), so OnBase's own
 * document security applies to every download.
 */

import { NextRequest, NextResponse } from 'next/server';
import { obContent, onbaseClientFailure } from '@/lib/onbase/service-client';
import {
  isOnBaseGrantRefusal,
  onbaseFailureText,
  ONBASE_LABEL,
} from '@/lib/mcp-tools/onbase/onbase-auth';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; documentId: string }> }
): Promise<NextResponse> {
  const { documentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  if (!documentId || /[/?#\s]/.test(documentId)) {
    return NextResponse.json({ error: 'Not a usable document id' }, { status: 400 });
  }

  const path = `/documents/${encodeURIComponent(documentId)}/revisions/latest/renditions/default/content`;
  const content = await obContent({ subject: session.subject, path });
  if (!content.ok) {
    // A grant the delegate would not open (not connected, revoked, not
    // refreshable) is the caller's to fix, so it reads as forbidden; a
    // worker or OnBase failure keeps the status it came with.
    if (isOnBaseGrantRefusal(content.err)) {
      return NextResponse.json(
        { error: onbaseFailureText(content.err, ONBASE_LABEL) },
        { status: 403 }
      );
    }
    const failure = onbaseClientFailure(content.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  const dispositionName = (
    /filename="?([^";]+)"?/.exec(content.val.contentDisposition ?? '')?.[1] ??
    `onbase-document-${documentId}`
  ).replace(/["\\\r\n]/g, '_');
  return new NextResponse(Buffer.from(content.val.bytes), {
    headers: {
      'Content-Type': content.val.contentType,
      'Content-Length': String(content.val.bytes.byteLength),
      'Content-Disposition': `attachment; filename="${dispositionName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
