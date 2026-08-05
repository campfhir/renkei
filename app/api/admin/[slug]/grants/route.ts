import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

/**
 * List all Atlassian grants (connected user accounts) for this tenant.
 * GET /api/admin/[slug]/grants
 *
 * Returns list of grants with basic info (cloud_id, account_id, expires_at)
 * Encrypted tokens are NOT included in the response.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const session = await getOperatorSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Verify tenant access
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Fetch grants for this tenant (without encrypted tokens)
    const grants = await db
      .selectFrom('atlassian_grants')
      .select([
        'account_id',
        'cloud_id',
        'operator_name',
        'expires_at',
        'created_at',
      ])
      .where('tenant_id', '=', tenant.id)
      .orderBy('created_at', 'desc')
      .execute();

    // Add expiration status for each grant
    const grantsWithStatus = grants.map((grant) => ({
      ...grant,
      isExpired: new Date(grant.expires_at) < new Date(),
    }));

    return NextResponse.json({
      grants: grantsWithStatus,
      total: grants.length,
    });
  } catch (error) {
    console.error('Error fetching grants:', error);
    return NextResponse.json(
      { error: 'Failed to fetch grants' },
      { status: 500 }
    );
  }
}
