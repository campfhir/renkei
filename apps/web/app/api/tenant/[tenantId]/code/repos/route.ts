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

export type { RepoChoice } from '@/lib/code/bitbucket-browse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const search = request.nextUrl.searchParams;
  const listed = await listRepositories(
    await bitbucketAuthFor(request, tenantId, session.subject),
    {
      workspace: (search.get('workspace') ?? '').trim() || undefined,
      project: (search.get('project') ?? '').trim() || undefined,
      query: (search.get('q') ?? '').trim().toLowerCase() || undefined,
    }
  );
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ repos: listed.repos });
}
