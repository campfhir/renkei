/**
 * POST: merge the pull request that promotes one environment to the next — which is what deploys, since the pipeline on the next branch runs,
 * with the person's own grant, under the repository's branch rules.
 * Editors only. Body: { from, to, number }, environments by name.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { mergePromotion } from '@/lib/ci/deployments';
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
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  const number = typeof body.number === 'number' && Number.isInteger(body.number) ? body.number : 0;
  const outcome = await mergePromotion({ subject, origin }, projectId, from, to, number);
  if (!outcome.ok) {
    if (outcome.status >= 500) {
      logger.warn(
        '{actor} merged pull request #{number} to promote {from} to {to} in the project "{project}" ({repository}), but the host refused; nothing was merged: {error}',
        {
          component: 'api/deployments/merge',
          ...(await whoIs(subject)),
          projectId,
          project: project.name,
          repository: project.repo.fullName,
          number,
          from,
          to,
          error: outcome.error,
        }
      );
    }
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  recordAuditEvent({
    actorSubject: subject,
    action: 'ci.promotion_merged',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName, from, to, number, url: outcome.url },
  });
  logger.info(
    '{actor} merged pull request #{number}, promoting {from} to {to} in the project "{project}" ({repository}); its pipeline deploys it',
    {
      component: 'api/deployments/merge',
      ...(await whoIs(subject)),
      projectId,
      project: project.name,
      repository: project.repo.fullName,
      number,
      from,
      to,
    }
  );
  return NextResponse.json({ number: outcome.number, url: outcome.url });
}
