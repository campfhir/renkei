/**
 * File bytes in and out of a share, session-guarded — this URL is what
 * fileshare_download_file hands to models, precisely because it requires
 * the caller's own signed-in session at click time instead of minting an
 * anonymous link. The bytes move through the fileshare worker on the
 * caller's own stored credential, so the file server authorizes every
 * transfer as that account.
 *
 * GET streams the bytes down with Content-Disposition: attachment; PUT is
 * the web UI's direct upload path (MCP writes stay on the upload-slot
 * flow). The worker enforces the org's attachment cap; the declared-length
 * check here only spares us buffering a hopeless upload.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromRequest } from '@/lib/session';
import { clientFailure, fsReadFile, fsWriteFile } from '@/lib/file-shares/service-client';

async function maxTransferBytes(tenantId: string): Promise<number> {
  const settings = await getOrgSettings(tenantId);
  return settings.ok ? settings.val.maxAttachmentBytes : 20_971_520;
}

/** A filename safe inside a quoted Content-Disposition value. */
function dispositionName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'download';
  return name.replace(/["\\\r\n]/g, '_');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const path = request.nextUrl.searchParams.get('path') ?? '';
  const content = await fsReadFile({ tenantId, shareId, subject: session.subject }, path);
  if (!content.ok) {
    const failure = clientFailure(content.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  return new NextResponse(Buffer.from(content.val), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.val.byteLength),
      'Content-Disposition': `attachment; filename="${dispositionName(path)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const path = request.nextUrl.searchParams.get('path') ?? '';
  const limit = await maxTransferBytes(tenantId);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    return NextResponse.json({ error: `File exceeds the ${limit}-byte limit` }, { status: 413 });
  }
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return NextResponse.json({ error: 'Empty upload' }, { status: 400 });
  }
  if (body.byteLength > limit) {
    return NextResponse.json({ error: `File exceeds the ${limit}-byte limit` }, { status: 413 });
  }

  const written = await fsWriteFile(
    { tenantId, shareId, subject: session.subject },
    path,
    new Uint8Array(body)
  );
  if (!written.ok) {
    const failure = clientFailure(written.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ ok: true, path: written.val.path });
}
