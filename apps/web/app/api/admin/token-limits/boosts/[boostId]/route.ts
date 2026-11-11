/** Take a boost back before its period ends. */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { readTokenLimitAdminView } from '@/lib/token-limits/admin';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ boostId: string }> }
): Promise<NextResponse> {
  const { boostId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(boostId)) return NextResponse.json({ error: 'No such boost' }, { status: 404 });

  const removed = await getDataStore().tokenLimits.revokeBoost(boostId);
  if (!removed) return NextResponse.json({ error: 'No such boost' }, { status: 404 });
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'token_limits.boost_revoked',
    targetKind: 'settings',
    details: { boostId },
  });
  logger.info('{actor} took back the token boost {boostId}', {
    component: 'api/admin/token-limits',
    ...who(session),
    boostId,
  });

  const view = await readTokenLimitAdminView();
  if (!view) {
    return NextResponse.json(
      { error: 'Removed, but the limits could not be read back' },
      { status: 500 }
    );
  }
  return NextResponse.json(view);
}
