import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';

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
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const store = getDataStore();

  try {
    const [grant] = await store.providerGrants.listForSubject(session.subject, {
      provider: 'atlassian',
    });

    if (!grant) {
      return NextResponse.json(
        { error: 'not_connected', message: 'You have no Jira account connected' },
        { status: 404 }
      );
    }

    // One transaction: a grant deleted while its tokens survive is the state
    // this route exists to avoid, and the reverse leaves a caller unable to
    // reach the tools while their Jira access is still stored.
    await store.providerGrants.disconnectWithMcpTokens('atlassian', session.subject);

    logger.info(
      '{actor} disconnected their Jira account {account}; the grant and the MCP tokens issued against it were deleted',
      {
        component: 'grants/store',
        ...who(session),
        accountId: grant.accountId,
        account: grant.displayName,
      }
    );
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'connector.disconnected',
      targetKind: 'connector',
      targetLabel: 'atlassian',
    });
    invalidateToolCatalogCache(session.subject);

    return NextResponse.json({
      revoked: true,
      account: grant.displayName,
      // Deleting the stored token stops this server using it. Atlassian keeps
      // its own record of the authorisation until the user withdraws it there,
      // so saying so is more honest than implying a full revocation.
      message:
        `Disconnected ${grant.displayName}. Reconnect any time. To also withdraw this app's ` +
        'access at Atlassian, remove it from your account settings there.',
    });
  } catch (error) {
    logger.error(
      '{actor} asked to disconnect their Jira account, but the grant was not deleted; it is still connected: {error}',
      {
        component: 'grants/store',
        ...who(session),
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
