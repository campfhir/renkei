import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';

export async function GET(
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

    // Tenant operator: can see all audit logs in tenant
    if (operatorKey) {
      const expectedKey = process.env[`OPERATOR_KEY_${tenantId}`.toUpperCase()];
      if (!expectedKey || operatorKey !== expectedKey) {
        return NextResponse.json({ error: 'Invalid operator credentials' }, { status: 403 });
      }

      return NextResponse.json({
        role: 'tenant_operator',
        type: 'tenant',
        tenantId,
        message: 'Audit logs are stored with @campfhir/bored-logs',
        logsProvider: 'bored-logs',
        logContext: `mcp:${tenantId}`,
      });
    }

    // Jira user: can only see their own audit logs
    if (!requestedAccountId) {
      return NextResponse.json(
        { error: 'Either x-operator-key header or accountId parameter required' },
        { status: 400 }
      );
    }

    // Verify user has a grant in this tenant
    const grant = await db
      .selectFrom('atlassian_grants')
      .select('account_id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', requestedAccountId)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    return NextResponse.json({
      role: 'jira_user',
      type: 'user',
      accountId: requestedAccountId,
      message: 'Audit logs are stored with @campfhir/bored-logs',
      logsProvider: 'bored-logs',
      logContext: `mcp:${tenantId}:${requestedAccountId}`,
    });
  } catch (error) {
    console.error('Failed to fetch audit logs:', error);
    return NextResponse.json({ error: 'Failed to fetch audit logs' }, { status: 500 });
  }
}
