/**
 * Disconnect the caller's own Microsoft grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * Disconnect is also a data-retention event: the grant's Graph
 * subscriptions are deleted (best-effort — an already-expired token just
 * means they lapse on their own within days, and the webhook route drops
 * their deliveries as unknown meanwhile), the subscription rows go, and
 * every knowledge chunk indexed from this mailbox is purged. Consent to
 * index was the grant; revoking one revokes the other.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { getSessionFromRequest } from '@/lib/session';
import { deleteGrant, getGrant, MICROSOFT } from '@renkei/provider-grants';
import { deleteGraphSubscription } from '@renkei/connector-microsoft';
import { deleteObjectChunks } from '@renkei/knowledge';
import { logger } from '@/lib/logger';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const grantRow = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.provider_account_id;

  // Best-effort provider-side cleanup while the credential still exists.
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (keyResult.ok) {
    const grant = await getGrant(MICROSOFT, tenantId, accountId, keyResult.val);
    if (grant.ok && grant.val) {
      const subscriptions = await db
        .selectFrom('webhook_subscriptions')
        .select(['subscription_id'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', MICROSOFT)
        .where('account_id', '=', accountId)
        .execute();
      for (const row of subscriptions) {
        if (!row.subscription_id) continue;
        const deleted = await deleteGraphSubscription(grant.val.accessToken, row.subscription_id);
        if (!deleted.ok) {
          logger.warn('Could not delete Graph subscription on disconnect; it will lapse', {
            component: 'connectors/microsoft',
            tenantId,
            subscriptionId: row.subscription_id,
          });
        }
      }
    }
  }

  await db
    .deleteFrom('webhook_subscriptions')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', MICROSOFT)
    .where('account_id', '=', accountId)
    .execute();

  // Purge this mailbox's chunks. The refId prefix is the owner's upn.
  const metadata: Record<string, unknown> =
    typeof grantRow.metadata === 'object' &&
    grantRow.metadata !== null &&
    !Array.isArray(grantRow.metadata)
      ? { ...grantRow.metadata }
      : {};
  const upn = typeof metadata.upn === 'string' ? metadata.upn.toLowerCase() : null;
  if (upn) {
    const purged = await deleteObjectChunks(tenantId, MICROSOFT, `${upn}/`, { prefixOnly: true });
    if (!purged.ok) {
      logger.warn('Could not purge knowledge chunks on disconnect', {
        component: 'connectors/microsoft',
        tenantId,
      });
    }
  }

  const deleted = await deleteGrant(MICROSOFT, tenantId, accountId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  return NextResponse.json({ message: 'Microsoft disconnected' });
}
