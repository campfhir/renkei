import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getOrigin } from '@/lib/get-origin';

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

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email')?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: 'Email required' }, { status: 400 });
  }

  const domain = emailDomain(email);
  if (!domain) {
    return NextResponse.json({ error: 'Invalid email domain' }, { status: 400 });
  }

  try {
    const db = getDatabase();

    // Check if tenant exists for this domain via tenant_domains table
    const tenant = await db
      .selectFrom('tenants')
      .leftJoin('tenant_domains', 'tenants.id', 'tenant_domains.tenant_id')
      .where('tenant_domains.domain', '=', domain)
      .select(['tenants.id', 'tenants.slug'])
      .executeTakeFirst();

    if (!tenant) {
      // Domain not found - redirect to create organization flow
      const origin = getOrigin(request);
      return NextResponse.redirect(
        new URL(`/create-organization?domain=${encodeURIComponent(domain)}`, origin)
      );
    }

    // Tenant exists - redirect to MCP endpoint
    const origin = getOrigin(request);
    return NextResponse.redirect(new URL(`/mcp/${tenant.id}`, origin));
  } catch (error) {
    console.error('Home-realm discovery error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
