import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { verificationRecord, verifyDomainOwnership } from '@/lib/domain-verification';
import { logger } from '@/lib/logger';

/**
 * Prove control of a tenant's email domain by reading back the
 * `renkei-verify=<token>` TXT record onboarding asked for
 * (lib/domain-verification.ts, migration 146). Until this succeeds the
 * sign-in page does not route the domain to the tenant.
 *
 * UNAUTHENTICATED BY DESIGN, like the rest of onboarding: the creator has
 * no session yet. It is also harmless to call — the only write is a
 * timestamp, set only when DNS says what only the domain's owner could make
 * it say — so the throttle exists to keep this from being a DNS-lookup
 * amplifier, not to protect the outcome. Registered as a deliberate
 * exception in lib/route-auth-coverage.test.ts.
 */
const LIMITS = {
  perClient: { limit: 10, windowMs: 10 * 60_000 },
  global: { limit: 100, windowMs: 10 * 60_000 },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {

  const verdict = checkInboundLimit(`tenant/verify-domain:${tenantId}`, request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        error: 'Too many verification attempts. DNS changes take a few minutes; try again shortly.',
      },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'domain_verification_token', 'domain_verified_at'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant.domain_verified_at) {
      return NextResponse.json({ verified: true, alreadyVerified: true });
    }
    if (!tenant.domain_verification_token) {
      return NextResponse.json(
        {
          error:
            'This organization has no verification token; an operator must verify it directly.',
        },
        { status: 409 }
      );
    }

    const domains = await db
      .selectFrom('tenant_domains')
      .select('domain')
      .execute();
    if (domains.length === 0) {
      return NextResponse.json(
        { error: 'No domain is registered for this organization' },
        { status: 409 }
      );
    }

    // Any one of the tenant's domains proving control is enough: they were
    // all claimed by the same creator in the same act.
    const expected = verificationRecord(tenant.domain_verification_token);
    const outcomes = [];
    for (const { domain } of domains) {
      const outcome = await verifyDomainOwnership(domain, tenant.domain_verification_token);
      if (outcome.verified) {
        await db
          .updateTable('tenants')
          .set({ domain_verified_at: new Date() })
          .where('id', '=', tenantId)
          .where('domain_verified_at', 'is', null)
          .execute();
        logger.info('Domain ownership verified', { component: 'web/home-realm', tenantId, domain });
        return NextResponse.json({ verified: true, domain });
      }
      outcomes.push({ domain, reason: outcome.reason });
    }

    logger.info('Domain ownership not yet verified', {
      component: 'web/home-realm',
      outcomes: outcomes.map((o) => `${o.domain}:${o.reason}`).join(','),
    });
    return NextResponse.json(
      {
        verified: false,
        // Not a secret — it is what gets published in public DNS — and the
        // one thing a creator who closed the page needs to finish.
        expected: { recordType: 'TXT', record: expected },
        domains: outcomes,
      },
      { status: 409 }
    );
  } catch (error) {
    logger.error('Domain verification error: {error}', {
      component: 'web/home-realm',
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
