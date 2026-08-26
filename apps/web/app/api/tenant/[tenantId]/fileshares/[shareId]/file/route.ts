/**
 * File bytes in and out of a share, session-guarded — this URL is what
 * fileshare_download_file hands to models, precisely because it re-checks
 * the caller's ACL at click time instead of minting an anonymous link.
 *
 * GET streams the bytes down with Content-Disposition: attachment; PUT is
 * the web UI's direct upload path (MCP writes stay on the upload-slot
 * flow). Both are size-capped by the org's attachment limit, and both
 * treat any ACL uncertainty as a refusal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import {
  effectiveAccess,
  normalizePath,
  openBackend,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import type { ShareBackend } from '@renkei/connector-fileshares';
import type { Result } from '@campfhir/safe-functions/types';
import { getSessionFromRequest } from '@/lib/session';
import { backendStatus, isRefusal, resolveShareAccess } from '@/lib/file-shares/access';
import type { ShareAccess } from '@/lib/file-shares/access';

async function withBackend<T>(
  shareId: string,
  access: ShareAccess,
  work: (backend: ShareBackend) => Promise<Result<T, string>>
): Promise<Result<T, string>> {
  return withSessionLimits(shareId, 'interactive', async () => {
    const opened = await openBackend(access.ctx.share, access.credentials);
    if (!opened.ok) return opened;
    try {
      return await work(opened.val);
    } finally {
      await opened.val.close();
    }
  });
}

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

  const access = await resolveShareAccess(tenantId, shareId, session.subject);
  if (isRefusal(access)) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const path = normalizePath(request.nextUrl.searchParams.get('path') ?? '');
  if (!path.ok || path.val === '/') {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }
  if (effectiveAccess(access.ctx, path.val) === 'none') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const limit = await maxTransferBytes(tenantId);
  const content = await withBackend(shareId, access, (backend) => backend.read(path.val, limit));
  if (!content.ok) {
    return NextResponse.json(
      { error: content.err.message ?? content.err.type },
      { status: backendStatus(content.err.type) }
    );
  }

  return new NextResponse(Buffer.from(content.val), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.val.byteLength),
      'Content-Disposition': `attachment; filename="${dispositionName(path.val)}"`,
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

  const access = await resolveShareAccess(tenantId, shareId, session.subject);
  if (isRefusal(access)) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const path = normalizePath(request.nextUrl.searchParams.get('path') ?? '');
  if (!path.ok || path.val === '/') {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }
  if (effectiveAccess(access.ctx, path.val) !== 'read_write') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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

  const written = await withBackend(shareId, access, (backend) =>
    backend.write(path.val, new Uint8Array(body))
  );
  if (!written.ok) {
    return NextResponse.json(
      { error: written.err.message ?? written.err.type },
      { status: backendStatus(written.err.type) }
    );
  }
  return NextResponse.json({ ok: true, path: path.val });
}
