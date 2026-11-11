/**
 * Exempt one person from the token limits, or put them back under them.
 * An exempt person's use is still counted and shown; nothing stops them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getDataStore } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { readTokenLimitAdminView } from '@/lib/token-limits/admin';
import { logger } from '@/lib/logger';
import { who, whoIs } from '@/lib/log-actor';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ subject: string }> }
): Promise<NextResponse> {
  const { subject: encoded } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // After the guard, and never a throw: a malformed escape is "no such person".
  let subject: string;
  try {
    subject = decodeURIComponent(encoded);
  } catch {
    return NextResponse.json({ error: 'No such person' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.exempt !== 'boolean') {
    return NextResponse.json({ error: 'exempt must be true or false' }, { status: 400 });
  }
  const store = getDataStore();
  if (!(await store.identities.get(subject))) {
    return NextResponse.json({ error: 'No such person' }, { status: 404 });
  }
  const before = await store.tokenLimits.isExempt(subject);
  if (before !== body.exempt) {
    await store.tokenLimits.setExempt(subject, body.exempt, session.subject);
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'token_limits.exemption_changed',
      targetKind: 'person',
      targetLabel: subject,
      details: { subject, exempt: body.exempt },
    });
    const person = await whoIs(subject);
    logger.info(
      body.exempt
        ? '{actor} exempted {owner} from the token limits; nothing stops their chats or agents now'
        : '{actor} put {owner} back under the token limits',
      {
        component: 'api/admin/token-limits',
        ...who(session),
        ownerSubject: person.subject,
        ownerName: person.user,
        ownerEmail: person.email,
        owner: person.actor,
      }
    );
  }
  const view = await readTokenLimitAdminView();
  if (!view) {
    return NextResponse.json(
      { error: 'Saved, but the limits could not be read back' },
      { status: 500 }
    );
  }
  return NextResponse.json(view);
}
