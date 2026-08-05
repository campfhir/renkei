import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

/**
 * Disconnect the caller's own Jira account.
 *
 * Scoped to the session's subject, so this revokes the grant of whoever is
 * asking and no one else's — an operator wanting to disconnect another user has
 * the admin route for that. A tenant id is not a secret (it appears in every
 * MCP endpoint URL), so the session is what authorises this, not the path.
 *
 * The tokens issued against the grant go with it. Leaving them would leave a
 * bearer token that still resolves to a user whose Jira access no longer
 * exists: the transport would authenticate the caller, find no grant, and
 * answer "Jira grant revoked" on every tool call. Deleting them makes the next
 * request a plain 401 that sends the client back through authorization.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const grant = await db
      .selectFrom('provider_grants')
      .select(['provider_account_id', 'display_name'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'atlassian')
      .where('subject', '=', session.subject)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json(
        { error: 'not_connected', message: 'You have no Jira account connected' },
        { status: 404 }
      );
    }

    // One transaction: a grant deleted while its tokens survive is the state
    // this route exists to avoid, and the reverse leaves a caller unable to
    // reach the tools while their Jira access is still stored.
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('provider_grants')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', 'atlassian')
        .where('subject', '=', session.subject)
        .execute();

      await trx
        .deleteFrom('oauth_access_tokens')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', session.subject)
        .execute();

      await trx
        .deleteFrom('oauth_refresh_tokens')
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', session.subject)
        .execute();
    });

    logger.info('[Grant] Revoked by owner', {
      tenantId,
      subject: session.subject,
      accountId: grant.provider_account_id,
    });

    return NextResponse.json({
      revoked: true,
      account: grant.display_name,
      // Deleting the stored token stops this server using it. Atlassian keeps
      // its own record of the authorisation until the user withdraws it there,
      // so saying so is more honest than implying a full revocation.
      message:
        `Disconnected ${grant.display_name}. Reconnect any time. To also withdraw this app's ` +
        'access at Atlassian, remove it from your account settings there.',
    });
  } catch (error) {
    logger.error('[Grant] Revocation failed', {
      tenantId,
      subject: session.subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
