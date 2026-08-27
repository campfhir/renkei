/**
 * Raw document bytes out of OnBase, session-guarded — this URL is what
 * onbase_download_document hands to models, precisely because it
 * re-resolves the CALLER'S OWN OnBase grant at click time instead of
 * minting an anonymous link. The bytes move through the OnBase worker
 * under that user's token, so OnBase's own document security applies to
 * every download.
 */

import { NextRequest, NextResponse } from 'next/server';
import { obContent, onbaseClientFailure } from '@/lib/onbase/service-client';
import { resolveOnBaseAccess } from '@/lib/mcp-tools/onbase/onbase-auth';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; documentId: string }> }
): Promise<NextResponse> {
  const { tenantId, documentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  if (!documentId || /[/?#\s]/.test(documentId)) {
    return NextResponse.json({ error: 'Not a usable document id' }, { status: 400 });
  }

  let access = await resolveOnBaseAccess({ tenantId, subject: session.subject });
  if (typeof access === 'string') {
    return NextResponse.json({ error: access }, { status: 403 });
  }
  const path = `/documents/${encodeURIComponent(documentId)}/revisions/latest/renditions/default/content`;
  let content = await obContent({ tenantId, accessToken: access.accessToken, path });
  if (!content.ok && content.err.kind === 'op' && content.err.status === 401) {
    // Same one-retry defensiveness as the tools: refresh once, then surface.
    access = await resolveOnBaseAccess({ tenantId, subject: session.subject }, { forceRefresh: true });
    if (typeof access === 'string') {
      return NextResponse.json({ error: access }, { status: 403 });
    }
    content = await obContent({ tenantId, accessToken: access.accessToken, path });
  }
  if (!content.ok) {
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
