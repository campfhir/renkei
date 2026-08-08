import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getDatabase } from '@renkei/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const body = await request.json();
    if (typeof body.site_id !== 'string' || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Missing site_id or enabled' }, { status: 400 });
    }
    const siteId = body.site_id;
    const enabled = body.enabled;

    if (!siteId || enabled === undefined) {
      return NextResponse.json({ error: 'Missing site_id or enabled' }, { status: 400 });
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
    return NextResponse.json({ error: 'Failed to update site' }, { status: 500 });
  }
}
