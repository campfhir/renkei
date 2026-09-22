/**
 * The GitHub repositories the signed-in person may put in a code project
 * (GET, for the new-project form's browser), and creating a brand-new
 * empty one (POST, for its "Create new repository" tab). Reads/writes
 * GitHub with their own grant; bounded, GET read-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { githubAuthFor, listRepositories, createRepository } from '@/lib/code/github-browse';
import { optionalString, readJsonBody } from '@/lib/chat/route-support';

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
  const listed = await listRepositories(await githubAuthFor(request, tenantId, session.subject), {
    account: (search.get('account') ?? '').trim() || undefined,
    query: (search.get('q') ?? '').trim().toLowerCase() || undefined,
  });
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 409 });
  return NextResponse.json({ repos: listed.repos });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const body = await readJsonBody(request);
  const account = optionalString(body.account, 200) ?? '';
  const name = optionalString(body.name, 200) ?? '';
  const created = await createRepository(await githubAuthFor(request, tenantId, session.subject), {
    account,
    name,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 409 });
  return NextResponse.json({ repo: created.repo });
}
