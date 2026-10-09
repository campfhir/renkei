import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { isReservedSlug } from '@/lib/tenant-slug';
import { seedDefaultClassifierRules } from '@renkei/email-sanitizer';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { logger } from '@/lib/logger';
import { isFreeEmailDomain, FREE_EMAIL_DOMAIN_ERROR } from '@/lib/free-email-domains';
import { generateSecret } from '@renkei/crypto';
import { mintBootstrapSecret } from '@/lib/tenant-bootstrap';
import { verificationRecord } from '@/lib/domain-verification';

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
  const normalizedDomain = domain.toLowerCase();
  if (!DOMAIN_SHAPE.test(normalizedDomain)) {
    return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
  }

  // This is the endpoint that actually mints a tenant — it must refuse free
  // domains itself rather than trust that every caller went through
  // /api/home-realm's earlier check first.
  if (isFreeEmailDomain(normalizedDomain)) {
    return NextResponse.json({ error: FREE_EMAIL_DOMAIN_ERROR }, { status: 400 });
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
      // Never the tenant's id: this caller is anonymous, and the id is what
      // the first identity-provider configuration and the verify-domain
      // route are addressed by. Whoever owns the domain signs in from the
      // home page; everyone else learns only that it is taken.
      return NextResponse.json(
        {
          error:
            'This domain already belongs to an organization. Sign in from the home page, or ask its administrator.',
          alreadyExists: true,
        },
        { status: 409 }
      );
    }

    // Create new tenant for this domain. The slug becomes a top-level URL
    // segment, so it must not shadow a real route — `create.organization`
    // would otherwise derive to the slug `create-organization`.
    const tenantId = randomUUID();
    let slug = domain.toLowerCase().replace(/\./g, '-');
    if (isReservedSlug(slug)) slug = `${slug}-org`;

    // Two things only the creator gets (lib/tenant-bootstrap.ts,
    // lib/domain-verification.ts): the one-time secret the first
    // identity-provider configuration must present, and the token to publish
    // as a TXT record before the sign-in page routes this domain here.
    const bootstrap = mintBootstrapSecret();
    const verificationToken = generateSecret(16);

    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        slug,
        created_at: new Date().toISOString(),
        bootstrap_secret_hash: bootstrap.hash,
        bootstrap_secret_expires_at: bootstrap.expiresAt,
        domain_verification_token: verificationToken,
        domain_verified_at: null,
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

    return NextResponse.json(
      {
        tenantId,
        alreadyExists: false,
        // Shown once; only its digest exists from here on.
        bootstrapSecret: bootstrap.secret,
        bootstrapSecretExpiresAt: bootstrap.expiresAt.toISOString(),
        domainVerification: {
          domain: normalizedDomain,
          recordType: 'TXT',
          record: verificationRecord(verificationToken),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Tenant creation error:', error);
    return NextResponse.json({ error: 'Failed to create tenant' }, { status: 500 });
  }
}
