/**
 * Folder creation from the files browser — the REST twin of
 * fileshare_create_folder: read/write on the PARENT is what authorizes
 * bringing a new child into being.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  effectiveAccess,
  normalizePath,
  openBackend,
  parentPath,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import { getSessionFromRequest } from '@/lib/session';
import { backendStatus, isRefusal, resolveShareAccess } from '@/lib/file-shares/access';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
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

  const body: unknown = await request.json().catch(() => null);
  const raw = isRecord(body) ? body.path : undefined;
  const path = normalizePath(typeof raw === 'string' ? raw : '');
  if (!path.ok || path.val === '/') {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }
  if (effectiveAccess(access.ctx, parentPath(path.val)) !== 'read_write') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const made = await withSessionLimits(shareId, 'interactive', async () => {
    const opened = await openBackend(access.ctx.share, access.credentials);
    if (!opened.ok) return opened;
    try {
      return await opened.val.mkdir(path.val);
    } finally {
      await opened.val.close();
    }
  });
  if (!made.ok) {
    return NextResponse.json(
      { error: made.err.message ?? made.err.type },
      { status: backendStatus(made.err.type) }
    );
  }
  return NextResponse.json({ ok: true, path: path.val });
}
