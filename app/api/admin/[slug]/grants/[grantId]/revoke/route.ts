import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

/**
 * Revoke a specific Atlassian grant (disconnect a user's Jira account).
 * POST /api/admin/[slug]/grants/[grantId]/revoke
 *
 * This removes the grant from the database, preventing future API access
 * with that grant. The user will need to re-authorize to reconnect.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; grantId: string }> }
) {
  const session = await getOperatorSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug, grantId } = await params;
  const db = getDatabase();

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

    // Verify grant belongs to this tenant
    const grant = await db
      .selectFrom('atlassian_grants')
      .select(['grant_id', 'account_display_name'])
      .where('grant_id', '=', grantId)
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    // Delete the grant
    await db
      .deleteFrom('atlassian_grants')
      .where('grant_id', '=', grantId)
      .execute();

    return NextResponse.json({
      success: true,
      grant_id: grantId,
      account: grant.account_display_name,
      message: `Grant for ${grant.account_display_name} has been revoked`,
    });
  } catch (error) {
    console.error('Error revoking grant:', error);
    return NextResponse.json(
      { error: 'Failed to revoke grant' },
      { status: 500 }
    );
  }
}
