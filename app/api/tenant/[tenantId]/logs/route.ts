import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { buildLogQueryOptions } from '@/lib/log-query';
import { parseRolesFromCookie } from '@/lib/oidc-roles';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const requestedAccountId = searchParams.get('accountId');

  // Get user roles from cookie (set by OIDC callback)
  // Stored as comma-separated string, parsed into a Set
  const userRolesStr = request.cookies.get(`oidc_roles_${tenantId}`)?.value;
  const userRoles = parseRolesFromCookie(userRolesStr);

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
      const adapter = new PostgresAdapter({ db });
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
      // User must have accountId to view their own logs
      if (!requestedAccountId) {
        return NextResponse.json(
          { error: 'accountId required to view logs' },
          { status: 400 }
        );
      }

      // Verify user has a Jira grant for this tenant
      const grant = await db
        .selectFrom('atlassian_grants')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('account_id', '=', requestedAccountId)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      // User can view only their own logs
      const queryOptions = buildLogQueryOptions(userQuery, tenantId, requestedAccountId);
      const adapter = new PostgresAdapter({ db });
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
        accountId: requestedAccountId,
        query: userQuery || undefined,
        logs: result.val,
        count: result.val.length,
      });
    }

    // No recognized role
    return NextResponse.json(
      { error: 'Invalid user role' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
