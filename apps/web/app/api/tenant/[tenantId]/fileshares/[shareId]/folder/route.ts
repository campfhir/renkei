/**
 * ACL-filtered folder listing for the files browser — the REST twin of
 * fileshare_list_folder, through the identical engine: closed entries are
 * absent, closed folders shielding a deeper allow come back as
 * 'traverse', and every visible entry carries the caller's own level.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  annotateEntries,
  canListFolder,
  effectiveAccess,
  normalizePath,
  openBackend,
  withSessionLimits,
} from '@renkei/connector-fileshares';
import { getSessionFromRequest } from '@/lib/session';
import { backendStatus, isRefusal, resolveShareAccess } from '@/lib/file-shares/access';

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

  const path = normalizePath(request.nextUrl.searchParams.get('path') ?? '/');
  if (!path.ok) {
    return NextResponse.json({ error: 'Unusable path' }, { status: 400 });
  }
  if (!canListFolder(access.ctx, path.val)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const listed = await withSessionLimits(shareId, 'interactive', async () => {
    const opened = await openBackend(access.ctx.share, access.credentials);
    if (!opened.ok) return opened;
    try {
      return await opened.val.list(path.val);
    } finally {
      await opened.val.close();
    }
  });
  if (!listed.ok) {
    return NextResponse.json(
      { error: listed.err.message ?? listed.err.type },
      { status: backendStatus(listed.err.type) }
    );
  }

  return NextResponse.json({
    path: path.val,
    share: { id: access.ctx.share.id, name: access.ctx.share.name },
    // The listed folder's own level, so the browser can offer (or not)
    // upload and new-folder controls without guessing from children.
    access: effectiveAccess(access.ctx, path.val),
    entries: annotateEntries(access.ctx, path.val, listed.val).map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      modifiedAt: entry.modifiedAt?.toISOString() ?? null,
      access: entry.access,
    })),
  });
}
