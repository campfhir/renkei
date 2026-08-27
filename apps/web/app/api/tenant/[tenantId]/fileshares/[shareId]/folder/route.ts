/**
 * Folder listing for the files browser — the REST twin of
 * fileshare_list_folder. The listing itself happens in the fileshare
 * worker (the process that owns every SMB/SFTP session and resolves the
 * caller's own stored credential per call); this route contributes exactly
 * one thing the worker cannot: who the caller is, from the browser
 * session. What the caller may see or do is the file server's verdict on
 * their account.
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
    entries: listed.val.entries,
  });
}
