/**
 * A code project's pull requests, read with the signed-in person's own
 * grant on whichever host the repository is on (repo-host.ts). `?view=summary`
 * answers just what the project page's card shows — the open count and
 * the most recently updated PR — the full list otherwise, for the Pulls
 * page.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectHostContext } from '@/lib/code/host-route-context';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectHostContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { project, adapter } = ready.context;
  const listed = await adapter.listPullRequests(project.repo!.fullName, {
    state: 'open',
    max: 25,
  });
  if (!listed.ok) return jsonError(502, 'host', listed.error);
  if (request.nextUrl.searchParams.get('view') === 'summary') {
    return NextResponse.json({
      openCount: listed.pullRequests.length,
      hasMore: listed.hasMore,
      mostRecent: listed.pullRequests[0] ?? null,
    });
  }
  return NextResponse.json({ pullRequests: listed.pullRequests, hasMore: listed.hasMore });
}
