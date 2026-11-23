/**
 * POST: start the project's pipeline by hand on a branch, with the
 * person's own grant — the checks on any branch, or an environment's
 * deploy from that environment's own branch (Bitbucket's custom pipeline,
 * GitHub's workflow_dispatch, as the pipeline file Renkei writes declares
 * them). Editors only. Body: { branch, run } — run is "checks" or an
 * environment's name.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { startManualRun } from '@/lib/ci/deployments';
import { builderContext } from '@/lib/ci/pipeline-builder-access';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await builderContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { subject, origin, project } = found.context;
  const body = await readJsonBody(request);
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  const run = typeof body.run === 'string' ? body.run.trim() : '';
  const outcome = await startManualRun({ subject, origin }, projectId, branch, run);
  const what = run === 'checks' ? 'the checks' : `the ${run} deploy`;
  if (!outcome.ok) {
    if (outcome.status >= 500) {
      logger.warn(
        '{actor} asked to start {what} on {branch} in the project "{project}" ({repository}), but the host refused; nothing started: {error}',
        {
          component: 'api/deployments/run',
          ...(await whoIs(subject)),
          projectId,
          project: project.name,
          repository: project.repo.fullName,
          what,
          branch,
          error: outcome.error,
        }
      );
    }
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  logger.info('{actor} started {what} on {branch} in the project "{project}" ({repository})', {
    component: 'api/deployments/run',
    ...(await whoIs(subject)),
    projectId,
    project: project.name,
    repository: project.repo.fullName,
    what,
    branch,
    url: outcome.url,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.pipeline_started',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName, branch, run, url: outcome.url },
  });
  return NextResponse.json({ url: outcome.url });
}
