import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { resolveLogCipher } from '@/lib/log-encryption';
import { buildLogQueryOptions } from '@/lib/log-query';
import { getSessionFromRequest } from '@/lib/session';

/** encrypt/decrypt for secure()-stored attributes, when LOG_ENCRYPTION_KEY is set. */
function logCipherOptions() {
  const resolved = resolveLogCipher();
  return resolved.state === 'on'
    ? { encrypt: resolved.cipher.encrypt, decrypt: resolved.cipher.decrypt }
    : {};
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const requestedAccountId = searchParams.get('accountId');

  // Roles come from the server-side session, never from a client-supplied cookie.
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userRoles = new Set(session.roles);

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Parse user query from request body
    let userQuery: string | null = null;
    try {
      const body = await request.json();
      userQuery = body?.query || body?.filter || null;
    } catch {
      // If no body, use empty query
    }

    // Enforce role-based access control
    // renkei-operator: can view aggregated logs for entire tenant
    // renkei-user: can view only their own logs (requires accountId)

    // Check for operator role
    if (userRoles.has('renkei-operator')) {
      // Operator can view all logs, filter by tenant only
      const queryOptions = buildLogQueryOptions(userQuery, tenantId);
      const adapter = new PostgresAdapter({ db, ...logCipherOptions() });
      const result = await adapter.query(queryOptions);

      if (!result.ok) {
        console.error('Query error:', result.err);
        return NextResponse.json(
          { error: result.err.message || 'Failed to query logs' },
          { status: 500 }
        );
      }

      return NextResponse.json({
        role: 'renkei-operator',
        roles: [...userRoles],
        tenantId,
        query: userQuery || undefined,
        logs: result.val,
        count: result.val.length,
      });
    }

    // Check for user role
    if (userRoles.has('renkei-user')) {
      // A user sees only their own logs. The account id is derived from the
      // caller's own grant, never read from the query string — "this account
      // has a grant" is not "the caller owns this account", so trusting a
      // client-supplied accountId let any user read another user's logs. A
      // grant with a NULL subject predates per-user ownership and never matches.
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

      // A caller may still name an account, but only their own: serving their
      // own logs under someone else's id would misreport whose activity these are.
      if (requestedAccountId && requestedAccountId !== accountId) {
        return NextResponse.json({ error: 'Cannot view other users logs' }, { status: 403 });
      }

      // User can view only their own logs
      const queryOptions = buildLogQueryOptions(userQuery, tenantId, accountId);
      const adapter = new PostgresAdapter({ db, ...logCipherOptions() });
      const result = await adapter.query(queryOptions);

      if (!result.ok) {
        console.error('Query error:', result.err);
        return NextResponse.json(
          { error: result.err.message || 'Failed to query logs' },
          { status: 500 }
        );
      }

      return NextResponse.json({
        role: 'renkei-user',
        roles: [...userRoles],
        tenantId,
        accountId,
        query: userQuery || undefined,
        logs: result.val,
        count: result.val.length,
      });
    }

    // No recognized role
    return NextResponse.json({ error: 'Invalid user role' }, { status: 403 });
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
