/** The Bitbucket workspaces the signed-in person belongs to — for the new-project form's browser. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { bitbucketAuthFor, listWorkspaces } from '@/lib/code/bitbucket-browse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const listed = await listWorkspaces(await bitbucketAuthFor(request, tenantId, session.subject));
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ workspaces: listed.workspaces });
}
