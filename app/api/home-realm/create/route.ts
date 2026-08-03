import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

export async function POST(request: NextRequest) {
  const { domain } = await request.json();

  if (!domain) {
    return NextResponse.json({ error: 'Domain required' }, { status: 400 });
  }

  // Validate domain format
  const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!DOMAIN_SHAPE.test(domain.toLowerCase())) {
    return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
  }

  try {
    const db = getDatabase();

    // Check if domain already exists
    const existing = await db
      .selectFrom('tenant_domains')
      .select('tenant_id')
      .where('domain', '=', domain.toLowerCase())
      .executeTakeFirst();

    if (existing) {
      return NextResponse.json(
        { tenantId: existing.tenant_id, alreadyExists: true },
        { status: 200 }
      );
    }

    // Create new tenant for this domain
    const tenantId = randomUUID();
    const slug = domain.toLowerCase().replace(/\./g, '-');

    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        slug,
        created_at: new Date().toISOString(),
      })
      .execute();

    // Map domain to tenant
    await db
      .insertInto('tenant_domains')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        domain: domain.toLowerCase(),
        created_at: new Date().toISOString(),
      })
      .execute();

    console.log(`[Domain] Created tenant for ${domain}: ${tenantId}`);

    return NextResponse.json({ tenantId, alreadyExists: false }, { status: 201 });
  } catch (error) {
    console.error('Tenant creation error:', error);
    return NextResponse.json({ error: 'Failed to create tenant' }, { status: 500 });
  }
}
