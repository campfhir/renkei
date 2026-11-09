/**
 * Operator "sign out everywhere" for one person: every browser session,
 * every MCP access token and every refresh token they hold in this tenant,
 * deleted now. Non-destructive to their data — chats, keys, grants all
 * stay — so it is the right first move when a device is lost or an account
 * is suspected compromised, before the irreversible key shred next to it
 * (./keys). The person signs in again and carries on.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDataStore } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who, whoIs } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subject: string }> }
): Promise<NextResponse> {
  const { subject: encoded } = await params;
  const subject = decodeURIComponent(encoded);
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (access.subject === subject) {
    return NextResponse.json(
      { error: 'Sign yourself out from the menu, not from here.' },
      { status: 400 }
    );
  }
  const counts = await getDataStore().sessions.revokeAll(subject);

  recordAuditEvent({
    actorSubject: access.subject,
    action: 'user.sessions_revoked',
    targetKind: 'person',
    targetLabel: subject,
    details: { subject, ...counts },
  });
  const owner = await whoIs(subject);
  logger.info(
    '{actor} signed {owner} out everywhere: {sessions} browser sessions, {accessTokens} access tokens and {refreshTokens} refresh tokens were revoked',
    {
      component: 'admin/access',
      ...who(access),
      ownerSubject: owner.subject,
      ownerName: owner.user,
      ownerEmail: owner.email,
      owner: owner.actor,
      ...counts,
    }
  );
  void request;
  return NextResponse.json({ success: true, revoked: counts });
}
