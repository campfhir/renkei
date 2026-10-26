/** The Bitbucket workspaces the signed-in person belongs to — for the new-project form's browser. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { bitbucketAuthFor, listWorkspaces } from '@/lib/code/bitbucket-browse';
import { routeLog } from '@/lib/log-context';

async function GETHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const listed = await listWorkspaces(await bitbucketAuthFor(request, session.subject));
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ workspaces: listed.workspaces });
}

export const GET = routeLog(GETHandler);
