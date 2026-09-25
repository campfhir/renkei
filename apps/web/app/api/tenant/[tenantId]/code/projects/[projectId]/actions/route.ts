/**
 * A GitHub code project's Actions runs — the project page's card, and
 * the full recent list for its own page. Bitbucket has the richer
 * Pipelines page (pipelines/route.ts: the switch, the config file, the
 * variables) — this is deliberately the smaller GitHub counterpart:
 * awareness of recent runs, not their configuration, which GitHub's own
 * Actions UI already owns.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GITHUB } from '@renkei/provider-grants';
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
  if (project.repo!.provider !== GITHUB) {
    return jsonError(404, 'not-found', 'This project’s repository is not on GitHub.');
  }
  const origin = await getOrigin(request);
  const adapter = hostAdapterFor(project.repo!.provider, {
    tenantId,
    subject: session.subject,
    origin: origin.ok ? origin.val : '',
  });
  if (!adapter) return jsonError(409, 'unsupported-host', 'This repository’s host is not supported.');
  const summary = request.nextUrl.searchParams.get('view') === 'summary';
  const listed = await adapter.listPipelineRuns(project.repo!.fullName, {
    branch: project.repo!.branch || undefined,
    max: summary ? 1 : 25,
  });
  if (!listed.ok) return jsonError(502, 'host', listed.error);
  if (summary) return NextResponse.json({ lastRun: listed.runs[0] ?? null });
  return NextResponse.json({ runs: listed.runs });
}
