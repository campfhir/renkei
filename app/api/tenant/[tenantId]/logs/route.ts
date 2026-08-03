import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const requestedAccountId = searchParams.get('accountId');
  const operatorKey = request.headers.get('x-operator-key');

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

    // Check permissions
    if (!operatorKey && !requestedAccountId) {
      return NextResponse.json(
        { error: 'Either x-operator-key header or accountId parameter required' },
        { status: 400 }
      );
    }

    // Parse query from request body
    let queryOptions: Record<string, any> = {};
    try {
      const body = await request.json();
      queryOptions = body || {};
    } catch {
      // If no body, use empty query options
    }

    // Initialize context filters based on role
    const contextFilters: Record<string, string> = {
      tenantId,
    };

    // Tenant operator: can see all logs, filter by tenant only
    if (operatorKey) {
      const expectedKey = process.env[`OPERATOR_KEY_${tenantId}`.toUpperCase()];
      if (!expectedKey || operatorKey !== expectedKey) {
        return NextResponse.json({ error: 'Invalid operator credentials' }, { status: 403 });
      }

      // Overload context to ensure tenant filter
      queryOptions.context = {
        ...queryOptions.context,
        tenantId, // Force tenant filter
      };
    } else {
      // Jira user: can only see their own logs
      const grant = await db
        .selectFrom('atlassian_grants')
        .select('account_id')
        .where('tenant_id', '=', tenantId)
        .where('account_id', '=', requestedAccountId)
        .executeTakeFirst();

      if (!grant) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }

      // Overload context to ensure tenant and accountId filters
      queryOptions.context = {
        ...queryOptions.context,
        tenantId, // Force tenant filter
        accountId: requestedAccountId, // Force account filter
      };
    }

    // Query logs from bored-logs
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
      role: operatorKey ? 'tenant_operator' : 'jira_user',
      tenantId,
      accountId: requestedAccountId || undefined,
      logs: result.val,
      count: result.val.length,
    });
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
