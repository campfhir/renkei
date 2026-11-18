/**
 * POST: open the pull request that promotes one environment to the next (from its branch into the next one's),
 * with the person's own grant, under the repository's branch rules.
 * Editors only. Body: { from, to }, environments by name.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { openPromotion } from '@/lib/ci/deployments';
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
  const outcome = await openPromotion({ subject, origin }, projectId, from, to);
  if (!outcome.ok) {
    if (outcome.status >= 500) {
      logger.warn(
        '{actor} asked to promote {from} to {to} in the project "{project}" ({repository}), but the host refused the pull request; none was opened: {error}',
        {
          component: 'api/deployments/promote',
          ...(await whoIs(subject)),
          projectId,
          project: project.name,
          repository: project.repo.fullName,
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
    action: 'ci.promotion_opened',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, repository: project.repo.fullName, from, to, url: outcome.url },
  });
  return NextResponse.json({ number: outcome.number, url: outcome.url });
}
