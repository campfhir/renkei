/**
 * POST: a deploy step of a pipeline built from blocks says it started,
 * succeeded or failed (@renkei/ci-blocks report.ts writes the command).
 * No session and no secret: the step's OpenID Connect token, signed by
 * GitHub Actions or Bitbucket Pipelines, names the repository
 * (lib/ci/oidc.ts), and the report lands on the code project whose builder
 * wrote that repository's pipeline (lib/ci/deployment-reports.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordDeploymentReport } from '@/lib/ci/deployment-reports';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest): Promise<Response> {
  const origin = await getOrigin(request);
  const body: unknown = await request.json().catch(() => null);
  const outcome = await recordDeploymentReport({
    authorization: request.headers.get('authorization'),
    body,
    origin: origin.ok ? origin.val : '',
    now: new Date(),
  });
  if (!outcome.ok) {
    logger.warn(
      'A pipeline sent a deployment report Renkei did not take; nothing was recorded: {error}',
      { component: 'api/deployments/report', status: outcome.status, error: outcome.error }
    );
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  logger.info(
    'The {host} pipeline of the project "{project}" ({repository}) reported that {environment} {status} at {commit}',
    {
      component: 'api/deployments/report',
      projectId: outcome.projectId,
      project: outcome.project,
      repository: outcome.repository,
      host: outcome.host,
      environment: outcome.environment,
      status: outcome.status,
      commit: outcome.commit,
    }
  );
  return NextResponse.json({
    recorded: true,
    environment: outcome.environment,
    status: outcome.status,
  });
}
