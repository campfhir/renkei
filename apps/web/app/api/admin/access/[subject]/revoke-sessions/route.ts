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
import { getDatabase } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';

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
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const counts = await db.transaction().execute(async (trx) => {
    const sessions = await trx
      .deleteFrom('sessions')
      .where('subject', '=', subject)
      .executeTakeFirst();
    const accessTokens = await trx
      .deleteFrom('oauth_access_tokens')
      .where('subject', '=', subject)
      .executeTakeFirst();
    const refreshTokens = await trx
      .deleteFrom('oauth_refresh_tokens')
      .where('subject', '=', subject)
      .executeTakeFirst();
    return {
      sessions: Number(sessions.numDeletedRows),
      accessTokens: Number(accessTokens.numDeletedRows),
      refreshTokens: Number(refreshTokens.numDeletedRows),
    };
  });

  recordAuditEvent({
    actorSubject: access.subject,
    action: 'user.sessions_revoked',
    targetKind: 'person',
    targetLabel: subject,
    details: { subject, ...counts },
  });
  logger.info("Operator revoked a person's sessions and tokens", {
    component: 'admin/access',
    subject,
    ...counts,
  });
  void request;
  return NextResponse.json({ success: true, revoked: counts });
}
