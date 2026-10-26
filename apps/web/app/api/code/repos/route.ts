/**
 * The repositories the signed-in person may put in a code project — for
 * the new-project form: one workspace's (and one project's within it),
 * or every workspace's searched by name. Reads Bitbucket with their own
 * grant; bounded, and read-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { bitbucketAuthFor, listRepositories } from '@/lib/code/bitbucket-browse';
import { routeLog } from '@/lib/log-context';

export type { RepoChoice } from '@/lib/code/bitbucket-browse';

async function GETHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!(await sandboxWorkspacesEnabled()))
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const search = request.nextUrl.searchParams;
  const listed = await listRepositories(await bitbucketAuthFor(request, session.subject), {
    workspace: (search.get('workspace') ?? '').trim() || undefined,
    project: (search.get('project') ?? '').trim() || undefined,
    query: (search.get('q') ?? '').trim().toLowerCase() || undefined,
  });
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ repos: listed.repos });
}

export const GET = routeLog(GETHandler);
