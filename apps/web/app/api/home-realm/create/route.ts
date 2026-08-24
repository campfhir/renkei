import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { isReservedSlug } from '@/lib/tenant-slug';
import { seedDefaultClassifierRules } from '@renkei/email-sanitizer';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { logger } from '@/lib/logger';

/**
 * Self-service onboarding: an email domain nothing yet claims becomes a
 * tenant. UNAUTHENTICATED BY DESIGN — there is no one to authenticate before
 * the first tenant exists — which makes the throttle below the only thing
 * standing between this endpoint and an open tenant factory. Registered as a
 * deliberate exception in lib/route-auth-coverage.test.ts.
 */
const LIMITS = {
  // A person onboarding an organization does it once. A handful of attempts
  // covers typos and a re-submit; nothing legitimate needs more.
  perClient: { limit: 5, windowMs: 60 * 60 * 1000 },
  // The ceiling that cannot be widened by forging a client address.
  global: { limit: 20, windowMs: 60 * 60 * 1000 },
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verdict = checkInboundLimit('home-realm/create', request, LIMITS);
  if (!verdict.allowed) {
    logger.warn('tenant creation throttled', {
      component: 'web/home-realm',
      ip: request.headers.get('x-forwarded-for') ?? undefined,
    });
    return NextResponse.json(
      { error: 'Too many organization attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

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
