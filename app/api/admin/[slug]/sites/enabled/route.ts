import { NextRequest, NextResponse } from 'next/server';
import { getOperatorSession } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getOperatorSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const db = getDatabase();

  try {
    const body = await request.json();
    if (typeof body.site_id !== 'string' || typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing site_id or enabled' },
        { status: 400 }
      );
    }
    const siteId = body.site_id;
    const enabled = body.enabled;

    if (!siteId || enabled === undefined) {
      return NextResponse.json(
        { error: 'Missing site_id or enabled' },
        { status: 400 }
      );
    }

    // Verify site belongs to this tenant
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    const site = await db
      .selectFrom('tenant_jira_sites')
      .select(['site_id'])
      .where('site_id', '=', siteId)
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();

    if (!site) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404 });
    }

    // Update site
    await db
      .updateTable('tenant_jira_sites')
      .set({ enabled })
      .where('site_id', '=', siteId)
      .execute();

    return NextResponse.json({
      success: true,
      site_id: siteId,
      enabled,
    });
  } catch (error) {
    console.error('Error updating site:', error);
    return NextResponse.json(
      { error: 'Failed to update site' },
      { status: 500 }
    );
  }
}
