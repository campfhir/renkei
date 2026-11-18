/**
 * The Apex panel's Propose: the checkout's Apex as a Salesforce admin
 * change request — the same review, validation (running the named tests)
 * and operator approval as every other change, deploying only when every
 * test passes and each class and trigger it changes is 80% covered.
 *
 *   POST { org, tests: string[], names?, deactivateTriggers?, deleteClasses?, reason? }
 *     → ApexProposal (lib/code/salesforce-apex.ts): its id, review link and validation
 *
 * The chat's owner, an editor of the project, only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { apexNames, failed, proposeApex } from '@/lib/code/salesforce-apex';
import { apexFailureResponse, apexRouteContext } from '@/lib/code/salesforce-apex-route';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: true });
  if (!ready.ok) return ready.response;
  const body: unknown = await request.json().catch(() => null);
  const input = isRecord(body) ? body : {};
  const proposed = await proposeApex(ready.context.checkout, ready.context.caller, {
    ...(typeof input.org === 'string' ? { org: input.org } : {}),
    tests: apexNames(input.tests),
    names: apexNames(input.names),
    deactivateTriggers: apexNames(input.deactivateTriggers),
    deleteClasses: apexNames(input.deleteClasses),
    ...(typeof input.reason === 'string' ? { reason: input.reason.slice(0, 1000) } : {}),
  });
  if (failed(proposed)) return apexFailureResponse(ready.context, proposed, 'propose Apex');
  recordAuditEvent({
    actorSubject: ready.context.session.subject,
    action: 'code.salesforce_apex_proposed',
    targetKind: 'code_project',
    targetLabel: ready.context.project.name,
    details: { projectId: ready.context.project.id, changeId: proposed.changeId },
  });
  logger.info(
    '{actor} proposed "{title}" from the code project "{project}"; it waits for an operator',
    {
      component: 'api/code/salesforce-apex',
      ...who(ready.context.session),
      title: proposed.title,
      changeId: proposed.changeId,
      project: ready.context.project.name,
      projectId: ready.context.project.id,
    }
  );
  return NextResponse.json({
    changeId: proposed.changeId,
    url: proposed.url,
    title: proposed.title,
    validation: proposed.validation,
  });
}
