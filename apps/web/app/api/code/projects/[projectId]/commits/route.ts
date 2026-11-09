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
import { codeProjectContext } from '@/lib/code/route-access';
import { hostAdapterFor } from '@/lib/code/repo-host';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  const origin = await getOrigin(request);
  const adapter = hostAdapterFor(project.repo!.provider, {
    subject: session.subject,
    origin: origin.ok ? origin.val : '',
  });
  if (!adapter)
    return jsonError(409, 'unsupported-host', 'This repository’s host is not supported.');
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
  if (!listed.ok) {
    logger.warn(
      '{actor} opened the commits of the project "{project}" ({repository}), but the code host did not list them; the page showed the error: {error}',
      {
        component: 'api/code/projects/commits',
        ...who(session),
        projectId,
        project: project.name,
        repository: project.repo!.fullName,
        error: listed.error,
      }
    );
    return jsonError(502, 'host', listed.error);
  }
  if (summary) return NextResponse.json({ mostRecent: listed.commits[0] ?? null });
  return NextResponse.json({ commits: listed.commits, hasMore: listed.hasMore });
}
