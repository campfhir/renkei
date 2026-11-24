/**
 * POST ?branch=BRANCH: the report step for a pipeline written by hand on
 * that branch (lib/ci/report-step.ts) — YAML to copy into the step that
 * deploys the branch's environment, so Renkei shows what runs there.
 * Taking it records, for the project, how the host's tokens name its
 * repository, which is how a report finds the project. Editors only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { jsonError } from '@/lib/chat/route-support';
import { branchContext } from '@/lib/ci/pipeline-builder-access';
import { reportStep } from '@/lib/ci/report-step';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const found = await branchContext(request, projectId, { write: true });
  if (!found.ok) return found.response;
  const { project, subject, origin, host, environment } = found.context;
  const outcome = await reportStep({ subject, origin }, host, project, environment);
  if (!outcome.ok) {
    logger.warn(
      '{actor} asked for the report step of {environment} for the project "{project}" ({repository}), but it could not be prepared; reports from that repository are not taken yet: {error}',
      {
        component: 'api/code/projects/report-step',
        ...(await whoIs(subject)),
        projectId,
        project: project.name,
        repository: project.repo.fullName,
        environment,
        error: outcome.error,
      }
    );
    return jsonError(outcome.status, 'report-step', outcome.error);
  }
  logger.info(
    '{actor} took the report step of {environment} for the project "{project}" ({repository}); its {host} pipelines’ reports are now taken',
    {
      component: 'api/code/projects/report-step',
      ...(await whoIs(subject)),
      projectId,
      project: project.name,
      repository: project.repo.fullName,
      environment,
      host,
    }
  );
  return NextResponse.json(outcome.step);
}
