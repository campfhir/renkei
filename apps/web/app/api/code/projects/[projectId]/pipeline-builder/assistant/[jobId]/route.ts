/**
 * GET: one of the person's pipeline-assistant questions on this project
 * (lib/ci/assistant-jobs.ts), as the page polls it:
 *
 *   { status: 'running', step }       what it is doing now
 *   { status: 'succeeded', answer }   { reply, proposal, buildingBlock, read }
 *   { status: 'failed', error }       why there is no answer (a job silent
 *                                     for minutes reads as interrupted)
 *
 * 404 for a job that is not theirs, not this project's, or gone.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/chat/route-support';
import { readAssistantJob } from '@/lib/ci/assistant-jobs';
import { builderContext } from '@/lib/ci/pipeline-builder-access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; jobId: string }> }
): Promise<Response> {
  const { projectId, jobId } = await params;
  const found = await builderContext(request, projectId);
  if (!found.ok) return found.response;
  const job = UUID.test(jobId)
    ? await readAssistantJob(found.context.subject, found.context.project.id, jobId, new Date())
    : null;
  if (!job) return jsonError(404, 'not-found', 'That question is not here any more; ask again.');
  return NextResponse.json(job, { headers: { 'cache-control': 'no-store' } });
}
