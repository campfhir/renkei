import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';

/**
 * Where to find audit logs for this tenant, scoped to what the caller may see.
 *
 * This previously had no authentication. A non-operator caller supplied an
 * `accountId` in the query string and the route checked only that *some* grant
 * existed for it — authorization standing in for authentication, since "this
 * account has a grant" is not "the caller is this account". Anyone could
 * enumerate account ids against it.
 *
 * The operator path was an `x-operator-key` header compared against
 * `OPERATOR_KEY_{tenantId}`. That env var name contains the hyphens of a UUID
 * and so cannot be set by ordinary means; the branch always fell through to its
 * 403. It is replaced by the session role check the sibling logs and sessions
 * routes already use, rather than carrying a second auth scheme that never
 * worked.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  // Roles come from the server-side session, never from a client-supplied
  // header or cookie.
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userRoles = new Set(session.roles);

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // renkei-operator: the whole tenant.
    if (userRoles.has('renkei-operator')) {
      return NextResponse.json({
        role: 'renkei-operator',
        roles: [...userRoles],
        type: 'tenant',
        tenantId,
        message: 'Audit logs are stored with @campfhir/bored-logs',
        logsProvider: 'bored-logs',
        logContext: `mcp:${tenantId}`,
      });
    }

    // renkei-user: only themselves. The account id is derived from the
    // caller's own grant rather than read from the query string, so there is
    // nothing for a caller to point at another user. A grant with a NULL
    // subject predates per-user ownership and never matches.
    if (userRoles.has('renkei-user')) {
      const grant = await db
        .selectFrom('provider_grants')
        .select('provider_account_id')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', 'atlassian')
        .where('subject', '=', session.subject)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'No Jira grant for this user' }, { status: 403 });
      }

      const accountId = grant.provider_account_id;

      // A caller may still name an account, but only their own: silently
      // serving their own logs under someone else's id would misreport whose
      // activity was returned.
      const requestedAccountId = new URL(request.url).searchParams.get('accountId');
      if (requestedAccountId && requestedAccountId !== accountId) {
        return NextResponse.json({ error: 'Cannot view other users audit logs' }, { status: 403 });
      }

      return NextResponse.json({
        role: 'renkei-user',
        roles: [...userRoles],
        type: 'user',
        tenantId,
        accountId,
        message: 'Audit logs are stored with @campfhir/bored-logs',
        logsProvider: 'bored-logs',
        logContext: `mcp:${tenantId}:${accountId}`,
      });
    }

    return NextResponse.json({ error: 'Invalid user role' }, { status: 403 });
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
