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
import { codeProjectContext } from '@/lib/code/route-access';
import { hostAdapterFor } from '@/lib/code/repo-host';
import { getOrigin } from '@/lib/get-origin';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  const origin = await getOrigin(request);
  const adapter = hostAdapterFor(project.repo!.provider, {
    tenantId,
    subject: session.subject,
    origin: origin.ok ? origin.val : '',
  });
  if (!adapter) return jsonError(409, 'unsupported-host', 'This repository’s host is not supported.');
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
