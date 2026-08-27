/**
 * One entry's details for the files browser's info modal — the REST twin
 * of fileshare_stat. The stat runs in the fileshare worker on the caller's
 * own stored credential; created/owner/group are null where the protocol
 * has nothing to say.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { clientFailure, fsStatEntry } from '@/lib/file-shares/service-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; shareId: string }> }
): Promise<NextResponse> {
  const { tenantId, shareId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const stats = await fsStatEntry(
    { tenantId, shareId, subject: session.subject },
    request.nextUrl.searchParams.get('path') ?? ''
  );
  if (!stats.ok) {
    const failure = clientFailure(stats.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  return NextResponse.json({
    path: stats.val.path,
    kind: stats.val.kind,
    size: stats.val.size,
    modifiedAt: stats.val.modifiedAt,
    createdAt: stats.val.createdAt,
    owner: stats.val.owner,
    group: stats.val.group,
  });
}
