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
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> }
): Promise<NextResponse> {
  const { shareId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const listed = await fsListFolder(
    { shareId, subject: session.subject },
    request.nextUrl.searchParams.get('path') ?? '/'
  );
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn']('File share request failed ({status}): {error}', {
        component: 'api/fileshares/folder',
        subject: session.subject,
        shareId,
        operation: 'listed',
        status: failure.status,
        error: 'message' in listed.err && listed.err.message ? listed.err.message : failure.message,
      });
    }
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  return NextResponse.json({
    path: listed.val.path,
    share: listed.val.share,
    entries: listed.val.entries,
  });
}
