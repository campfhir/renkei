import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getJiraGrant } from '@/lib/tenant-operations';

export const GET = async (
  _request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) => {
  const { tenantId } = await params;
  const db = getDatabase();

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

    // Get Jira grant
    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id', 'cloud_id', 'operator_name'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json({
        connected: false,
        message: 'No Jira grant configured',
      });
    }

    const { account_id, operator_name } = grants[0];
    const grant = await getJiraGrant(tenantId, account_id);

    if (!grant) {
      return NextResponse.json({
        connected: false,
        message: 'Failed to retrieve grant',
      });
    }

    return NextResponse.json({
      connected: true,
      accountId: account_id,
      displayName: operator_name,
      siteUrl: grant.siteUrl,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return NextResponse.json(
      {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
};
