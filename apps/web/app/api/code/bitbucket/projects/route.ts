/** One Bitbucket workspace's projects — for the new-project form's browser. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { bitbucketAuthFor, listProjects } from '@/lib/code/bitbucket-browse';
import { routeLog } from '@/lib/log-context';

async function GETHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const workspace = (request.nextUrl.searchParams.get('workspace') ?? '').trim();
  if (!workspace) return NextResponse.json({ error: 'Say which workspace.' }, { status: 400 });
  const listed = await listProjects(await bitbucketAuthFor(request, session.subject), workspace);
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ projects: listed.projects });
}

export const GET = routeLog(GETHandler);
