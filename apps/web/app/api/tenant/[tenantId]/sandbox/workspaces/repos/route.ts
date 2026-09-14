/**
 * The repositories the signed-in person may clone — for the connectors
 * page's picker. Reads Bitbucket with their own grant: the workspaces
 * they belong to, then each workspace's repositories, filtered by `q`
 * against the full name. Bounded (a few pages), and read-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { sandboxWorkspacesEnabled } from '@/lib/sandbox/service-client';
import { oauthBitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import { bbJson, rec, str, values } from '@/lib/mcp-tools/bitbucket/client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

const MAX_WORKSPACES = 10;
const PAGE = 100;

export interface RepoChoice {
  fullName: string;
  mainBranch: string | null;
  updatedOn: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const query = (request.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();
  const origin = await getOrigin(request);
  const requestOrigin = origin.ok ? origin.val : '';

  // The auth only needs the caller's identity and origin; every other
  // field of the tool context is a Jira concern this route never touches.
  // Scopes are left unknown here, so Bitbucket's own 403 is the answer for
  // a connection narrowed away from `repository`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const context = {
    tenantId,
    subject: session.subject,
    origin: requestOrigin,
  } as MCPToolContext;
  const auth = oauthBitbucketAuth(context);

  const workspaces = await bbJson(auth, ['account'], `/workspaces?pagelen=${MAX_WORKSPACES}`);
  if (!workspaces.ok) return NextResponse.json({ error: workspaces.error }, { status: 409 });

  const repos: RepoChoice[] = [];
  for (const workspace of values(workspaces.body)) {
    const slug = str(workspace.slug);
    if (!slug) continue;
    const parts = [`pagelen=${PAGE}`, 'sort=-updated_on'];
    if (query) parts.push(`q=${encodeURIComponent(`name ~ "${query.replace(/"/g, '')}"`)}`);
    const listed = await bbJson(
      auth,
      ['repository'],
      `/repositories/${encodeURIComponent(slug)}?${parts.join('&')}`
    );
    if (!listed.ok) continue;
    for (const repo of values(listed.body)) {
      const fullName = str(repo.full_name);
      if (!fullName) continue;
      repos.push({
        fullName,
        mainBranch: str(rec(repo.mainbranch).name) || null,
        updatedOn: str(repo.updated_on) || null,
      });
    }
  }
  repos.sort((a, b) => (b.updatedOn ?? '').localeCompare(a.updatedOn ?? ''));
  return NextResponse.json({ repos });
}
