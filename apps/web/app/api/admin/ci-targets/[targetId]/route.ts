/**
 * One CI target — operators only.
 *
 *   PUT { name, description?, labels } → { ok }; 400 { error, problems }; 409 for a taken name
 *   DELETE → { ok }; pipelines already written keep their runs-on labels
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { deleteTarget, parseTargetPayload, updateTarget } from '@/lib/ci/targets';
import { isUuid } from '@/lib/uuid';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

type Params = { params: Promise<{ targetId: string }> };
const notFound = () =>
  NextResponse.json({ error: 'Target not found', problems: [] }, { status: 404 });

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { targetId } = await params;
  if (!isUuid(targetId)) return notFound();
  const parsed = parseTargetPayload(await request.json().catch(() => null));
  if ('error' in parsed) return NextResponse.json(parsed, { status: 400 });
  const updated = await updateTarget(targetId, parsed);
  if (!updated.ok) {
    return updated.error === 'taken'
      ? NextResponse.json(
          { error: `A target named “${parsed.name}” exists.`, problems: [] },
          { status: 409 }
        )
      : notFound();
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.target_saved',
    targetKind: 'ci_target',
    targetLabel: parsed.name,
    details: { targetId, labels: parsed.labels },
  });
  logger.info('{actor} changed the CI target "{target}"', {
    component: 'api/admin/ci-targets',
    ...who(session),
    target: parsed.name,
    targetId,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { targetId } = await params;
  if (!isUuid(targetId)) return notFound();
  const deleted = await deleteTarget(targetId);
  if (!deleted) return notFound();
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.target_deleted',
    targetKind: 'ci_target',
    targetLabel: deleted.name,
    details: { targetId },
  });
  logger.info('{actor} deleted the CI target "{target}"', {
    component: 'api/admin/ci-targets',
    ...who(session),
    target: deleted.name,
    targetId,
  });
  return NextResponse.json({ ok: true });
}
