import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { isReservedSlug } from '@/lib/tenant-slug';
import { seedDefaultClassifierRules } from '@renkei/email-sanitizer';

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    const dbResult = getDatabase();
    if (!dbResult.ok) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    const db = dbResult.val;

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

    // Create new tenant for this domain. The slug becomes a top-level URL
    // segment, so it must not shadow a real route — `create.organization`
    // would otherwise derive to the slug `create-organization`.
    const tenantId = randomUUID();
    let slug = domain.toLowerCase().replace(/\./g, '-');
    if (isReservedSlug(slug)) slug = `${slug}-org`;

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

    // Starting classifier rules, so mail categorization works from the
    // first sync rather than filing everything as human correspondence
    // until an admin happens to author rules. Best-effort: a failure here
    // must not prevent the tenant from existing.
    const seeded = await seedDefaultClassifierRules(tenantId);
    if (!seeded.ok) {
      console.warn(`[Domain] Could not seed classifier rules for ${tenantId}`);
    }

    console.log(`[Domain] Created tenant for ${domain}: ${tenantId}`);

    return NextResponse.json({ tenantId, alreadyExists: false }, { status: 201 });
  } catch (error) {
    console.error('Tenant creation error:', error);
    return NextResponse.json({ error: 'Failed to create tenant' }, { status: 500 });
  }
}
