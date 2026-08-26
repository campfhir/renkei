/**
 * ACL-filtered folder listing for the files browser — the REST twin of
 * fileshare_list_folder. The listing itself happens in the fileshare
 * worker (the process that owns every SMB/SFTP session and enforces the
 * ACL per call); this route contributes exactly one thing the worker
 * cannot: who the caller is, from the browser session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { clientFailure, fsListFolder } from '@/lib/file-shares/service-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const listed = await fsListFolder(
    { tenantId, shareId, subject: session.subject },
    request.nextUrl.searchParams.get('path') ?? '/'
  );
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  return NextResponse.json({
    path: listed.val.path,
    share: listed.val.share,
    // The listed folder's own level, so the browser can offer (or not)
    // upload and new-folder controls without guessing from children.
    access: listed.val.access,
    entries: listed.val.entries,
  });
}
