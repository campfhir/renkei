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
    if (typeof body.cloud_id !== 'string' || typeof body.jira_url !== 'string') {
      return NextResponse.json(
        { error: 'Missing cloud_id or jira_url' },
        { status: 400 }
      );
    }
    const cloudId = body.cloud_id;
    const jiraUrl = body.jira_url;

    if (!cloudId || !jiraUrl) {
      return NextResponse.json(
        { error: 'Missing cloud_id or jira_url' },
        { status: 400 }
      );
    }

    // Get tenant
    const tenant = await db
      .selectFrom('tenants')
      .select(['id'])
      .where('slug', '=', slug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Check if site is already claimed by another tenant
    const existing = await db
      .selectFrom('tenant_jira_sites')
      .select(['site_id'])
      .where('cloud_id', '=', cloudId)
      .executeTakeFirst();

    if (existing) {
      return NextResponse.json(
        { error: 'Site already claimed', conflict: true },
        { status: 409 }
      );
    }

    // Generate site ID (could be based on cloud_id or random)
    const siteId = `site_${cloudId.replace(/[^a-z0-9]/gi, '')}`;

    // Create site record
    await db
      .insertInto('tenant_jira_sites')
      .values({
        site_id: siteId,
        tenant_id: tenant.id,
        cloud_id: cloudId,
        jira_url: jiraUrl,
        enabled: true,
        claimed_at: new Date().toISOString(),
      })
      .execute();

    return NextResponse.json({
      success: true,
      site_id: siteId,
      cloud_id: cloudId,
    });
  } catch (error) {
    console.error('Error claiming site:', error);
    return NextResponse.json(
      { error: 'Failed to claim site' },
      { status: 500 }
    );
  }
}
