/**
 * Every service's recent log lines in one time-ordered stream, for the
 * Services page's combined tail (any member). `?since=` is the `at` of
 * the last entry the page already shows, so a page that follows asks
 * only for what came after; `?lines=` how many each container is asked
 * for. The worker stamps and merges; nothing here reads a container.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientFailure, sandboxServicesEnabled, sbServicesTail } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await codeProjectContext(request, projectId);
  if (!ready.ok) return ready.response;
  if (!(await sandboxServicesEnabled())) {
    return jsonError(
      503,
      'unavailable',
      'Code project services are not enabled on this deployment.'
    );
  }
  const since = request.nextUrl.searchParams.get('since');
  const lines = Number(request.nextUrl.searchParams.get('lines') ?? '');
  const tailed = await sbServicesTail(codeProjectTarget(projectId), {
    ...(since ? { since } : {}),
    ...(Number.isFinite(lines) && lines > 0 ? { lines } : {}),
  });
  if (!tailed.ok) {
    const failure = clientFailure(tailed.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn']('Sandbox request failed ({status}): {error}', {
        component: 'api/code/projects/services/tail',
        subject: ready.context.session.subject,
        projectId,
        operation: 'tailed',
        status: failure.status,
        error: 'message' in tailed.err && tailed.err.message ? tailed.err.message : failure.message,
      });
    }
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  return NextResponse.json(tailed.val);
}
