import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

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
    let tenant = await db
      .selectFrom('tenants')
      .leftJoin('tenant_domains', 'tenants.id', 'tenant_domains.tenant_id')
      .where('tenant_domains.domain', '=', domain)
      .select(['tenants.id', 'tenants.slug'])
      .executeTakeFirst();

    // If no tenant exists yet, create one for this domain
    if (!tenant) {
      const tenantId = randomUUID();
      const slug = domain.replace(/\./g, '-'); // Simple slug from domain

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
          domain,
          created_at: new Date().toISOString(),
        })
        .execute();

      tenant = { id: tenantId, slug };
    }

    // Redirect to the tenant's MCP endpoint for Jira authorization
    // The MCP endpoint should handle the Jira OAuth flow
    return NextResponse.redirect(new URL(`/mcp/${tenant.id}`, request.url));
  } catch (error) {
    console.error('Home-realm discovery error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
