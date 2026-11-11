/**
 * Grant one person extra tokens for the week or the month in progress. The
 * boost ends when that period resets (the instant is fixed here, at the
 * grant), and adds to the organization's limit for that period; it does not
 * raise a model's own limit.
 */

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getDataStore } from '@renkei/db';
import { getOrgSettings, tokenLimitPeriods, tokenLimitPolicy } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { readTokenLimitAdminView } from '@/lib/token-limits/admin';
import { logger } from '@/lib/logger';
import { who, whoIs } from '@/lib/log-actor';

const MAX_TOKENS = 1_000_000_000_000;
const NOTE_MAX_CHARS = 500;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  const { subject, period, tokens } = body;
  if (typeof subject !== 'string' || !subject) {
    return NextResponse.json({ error: 'subject is required' }, { status: 400 });
  }
  if (period !== 'week' && period !== 'month') {
    return NextResponse.json({ error: 'period must be week or month' }, { status: 400 });
  }
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || Math.trunc(tokens) < 1) {
    return NextResponse.json({ error: 'tokens must be a number above zero' }, { status: 400 });
  }
  const amount = Math.min(Math.trunc(tokens), MAX_TOKENS);
  const note =
    typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, NOTE_MAX_CHARS)
      : null;

  const store = getDataStore();
  if (!(await store.identities.get(subject))) {
    return NextResponse.json({ error: 'No such person' }, { status: 404 });
  }
  const settings = await getOrgSettings();
  if (!settings.ok) {
    logger.error(
      '{actor} granted a token boost, but the token limits could not be read; nothing was granted: {error}',
      {
        component: 'api/admin/token-limits',
        ...who(session),
        error: settings.err.message ?? settings.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read the token limits' }, { status: 500 });
  }
  const expiresAt = tokenLimitPeriods(tokenLimitPolicy(settings.val), new Date())[period].resetsAt;

  const id = randomUUID();
  await store.tokenLimits.grantBoost({
    id,
    subject,
    period,
    tokens: amount,
    expiresAt,
    grantedBy: session.subject,
    note,
  });
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'token_limits.boost_granted',
    targetKind: 'person',
    targetLabel: subject,
    details: { subject, boostId: id, period, tokens: amount, expiresAt: expiresAt.toISOString() },
  });
  const person = await whoIs(subject);
  logger.info('{actor} granted {owner} {tokens} extra tokens for this {period}, until {until}', {
    component: 'api/admin/token-limits',
    ...who(session),
    ownerSubject: person.subject,
    ownerName: person.user,
    ownerEmail: person.email,
    owner: person.actor,
    tokens: amount,
    period,
    until: expiresAt.toISOString(),
    boostId: id,
  });

  const view = await readTokenLimitAdminView();
  if (!view) {
    return NextResponse.json(
      { error: 'Granted, but the limits could not be read back' },
      { status: 500 }
    );
  }
  return NextResponse.json(view, { status: 201 });
}
