/**
 * A code project's recent commits, read with the signed-in person's own
 * grant on whichever host the repository is on (repo-host.ts) — on the
 * project's own branch, newest first. `?view=summary` answers just the
 * newest one for the project page's card; the full (paged) list
 * otherwise, for the scrolling Commits page.
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
  const summary = request.nextUrl.searchParams.get('view') === 'summary';
  const requestedMax = Number(request.nextUrl.searchParams.get('max'));
  const max = summary
    ? 1
    : Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, 100)
      : 30;
  const listed = await adapter.listCommits(project.repo!.fullName, {
    ref: project.repo!.branch || undefined,
    max,
  });
  if (!listed.ok) return jsonError(502, 'host', listed.error);
  if (summary) return NextResponse.json({ mostRecent: listed.commits[0] ?? null });
  return NextResponse.json({ commits: listed.commits, hasMore: listed.hasMore });
}
