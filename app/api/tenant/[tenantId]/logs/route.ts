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

    // Check permissions
    if (!operatorKey && !requestedAccountId) {
      return NextResponse.json(
        { error: 'Either x-operator-key header or accountId parameter required' },
        { status: 400 }
      );
    }

    // Tenant operator: can see all logs
    if (operatorKey) {
      const expectedKey = process.env[`OPERATOR_KEY_${tenantId}`.toUpperCase()];
      if (!expectedKey || operatorKey !== expectedKey) {
        return NextResponse.json({ error: 'Invalid operator credentials' }, { status: 403 });
      }

      // Return metadata for operator logs view
      return NextResponse.json({
        role: 'tenant_operator',
        tenantId,
        logContext: {
          tenantId,
        },
      });
    }

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

    // Return metadata for user logs view
    return NextResponse.json({
      role: 'jira_user',
      accountId: requestedAccountId,
      tenantId,
      logContext: {
        accountId: requestedAccountId,
      },
    });
  } catch (error) {
    console.error('Failed to fetch logs metadata:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
