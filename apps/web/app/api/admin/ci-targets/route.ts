/**
 * The organization's CI targets (lib/ci/targets.ts) — operators only.
 *
 *   GET ?fresh=1 → TargetsPage: the service accounts, what each host's
 *                  runners read as, each target with the runners that fit,
 *                  and the runners in no target (`fresh` reads them again)
 *   POST { name, description?, labels: { bitbucket, github } } → 201 { id };
 *        400 { error, problems }; 409 for a taken name
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { createTarget, parseTargetPayload, targetsPage } from '@/lib/ci/targets';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const page = await targetsPage({ fresh: request.nextUrl.searchParams.get('fresh') === '1' });
  return 'error' in page ? NextResponse.json(page, { status: 500 }) : NextResponse.json(page);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = parseTargetPayload(await request.json().catch(() => null));
  if ('error' in parsed) return NextResponse.json(parsed, { status: 400 });
  const created = await createTarget(parsed, session.subject);
  if (!created.ok) {
    return NextResponse.json(
      { error: `A target named “${parsed.name}” exists.`, problems: [] },
      { status: 409 }
    );
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'ci.target_saved',
    targetKind: 'ci_target',
    targetLabel: parsed.name,
    details: { targetId: created.id, labels: parsed.labels },
  });
  logger.info('{actor} added the CI target "{target}"', {
    component: 'api/admin/ci-targets',
    ...who(session),
    target: parsed.name,
    targetId: created.id,
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
