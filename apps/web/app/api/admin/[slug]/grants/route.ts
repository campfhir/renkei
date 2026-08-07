import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@renkei/db';

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
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
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
      .selectFrom('provider_grants')
      .select(['provider_account_id', 'display_name', 'metadata', 'expires_at', 'created_at'])
      .where('tenant_id', '=', tenant.id)
      .where('provider', '=', 'atlassian')
      .orderBy('created_at', 'desc')
      .execute();

    // Keep the wire shape the admin UI already consumes: cloud_id is now a
    // metadata key rather than a column, so it is unpacked here rather than
    // leaking the whole jsonb blob (which also carries provider internals).
    const grantsWithStatus = grants.map((grant) => {
      const metadata: Record<string, unknown> =
        typeof grant.metadata === 'object' && grant.metadata !== null ? { ...grant.metadata } : {};
      return {
        account_id: grant.provider_account_id,
        cloud_id: typeof metadata.cloudId === 'string' ? metadata.cloudId : '',
        operator_name: grant.display_name,
        expires_at: grant.expires_at,
        created_at: grant.created_at,
        isExpired: new Date(grant.expires_at) < new Date(),
      };
    });

    return NextResponse.json({
      grants: grantsWithStatus,
      total: grants.length,
    });
  } catch (error) {
    console.error('Error fetching grants:', error);
    return NextResponse.json({ error: 'Failed to fetch grants' }, { status: 500 });
  }
}
