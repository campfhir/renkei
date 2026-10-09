import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getOrigin } from '@/lib/get-origin';
import { isFreeEmailDomain, FREE_EMAIL_DOMAIN_ERROR } from '@/lib/free-email-domains';

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  // Basic domain shape validation
  const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
  return DOMAIN_SHAPE.test(domain) ? domain : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email')?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: 'Email required' }, { status: 400 });
  }

  const domain = emailDomain(email);
  if (!domain) {
    return NextResponse.json({ error: 'Invalid email domain' }, { status: 400 });
  }

  // Reject free/consumer domains before ever looking up or offering to
  // create a tenant for them — a personal Gmail address can't stand in for
  // an organization.
  if (isFreeEmailDomain(domain)) {
    return NextResponse.json({ error: FREE_EMAIL_DOMAIN_ERROR }, { status: 400 });
  }

  try {
    const dbResult = getDatabase();
    if (!dbResult.ok) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    const db = dbResult.val;

    // The tenant claiming this domain — and whether that claim is proven.
    // Only a tenant whose domain_verified_at is set is routable from here
    // (migration 146): a tenant created for a domain its creator does not
    // control must never receive that domain's sign-ins.
    const claim = await db
      .selectFrom('tenants')
      .leftJoin('tenant_domains', 'tenants.id', 'tenant_domains.tenant_id')
      .where('tenant_domains.domain', '=', domain)
      .select(['tenants.id', 'tenants.slug', 'tenants.domain_verified_at'])
      .executeTakeFirst();
    const tenant = claim?.domain_verified_at ? claim : null;

    if (!tenant) {
      const originResult = await getOrigin(request);
      if (!originResult.ok) {
        return NextResponse.json({ error: 'Config error' }, { status: 500 });
      }
      const origin = originResult.val;
      if (claim) {
        // Claimed but unproven: the onboarding page explains the TXT record
        // without naming the tenant — its id belongs to whoever created it.
        return NextResponse.redirect(
          new URL(`/create-organization?domain=${encodeURIComponent(domain)}&pending=1`, origin)
        );
      }
      // Domain not found - redirect to create organization flow
      return NextResponse.redirect(
        new URL(`/create-organization?domain=${encodeURIComponent(domain)}`, origin)
      );
    }

    // Tenant exists — send them to its home page. The page guards itself and
    // starts the OIDC flow if the browser holds no session.
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;
    return NextResponse.redirect(new URL(`/${tenant.slug}`, origin));
  } catch (error) {
    console.error('Home-realm discovery error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
